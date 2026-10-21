import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { ReplyDispatchDeliveryError } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { steerActiveSessionWithOptionalDeliveryWait } from "../embedded-agent-runner/run/attempt-queue-message.js";
import {
  cancelAskUserPromptDelivery,
  createAskUserTool,
  isAskUserPromptPending,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";

type GatewayCall = Extract<
  NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
  (...args: never[]) => unknown
>;
type SentPrompt = Parameters<
  NonNullable<Parameters<typeof createAskUserTool>[0]["questionPrompt"]>["send"]
>[0];

const replyDispatchOutcomeModuleUrl = new URL(
  "../../auto-reply/reply/reply-dispatch-outcome.ts",
  import.meta.url,
).href;

const SESSION_KEY = "agent:main:test";
const TOOL_CALL_ID = "call";
const IMAGE_REPLY = [{ type: "image" as const, data: "pixels", mimeType: "image/png" }];

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [
        { label: "Staging (Recommended)", description: "Safer default" },
        { label: "Production" },
      ],
    },
  ],
};

type RpcHandlers = Record<
  string,
  (params: Record<string, unknown>, extra?: { signal?: AbortSignal }) => Promise<unknown>
>;

function gatewayStub(handlers: RpcHandlers) {
  const started = {
    "question.request": createDeferred(),
    "question.waitAnswer": createDeferred(),
  };
  const mock = vi.fn(
    (
      method: string,
      _opts: Record<string, unknown>,
      params: Record<string, unknown>,
      extra?: { signal?: AbortSignal },
    ) => {
      const handler = handlers[method];
      if (!handler) {
        throw new Error(`unexpected method ${method}`);
      }
      const response = handler(params, extra);
      // Callback setup has completed, but the owner's later prompt-delivery phase
      // is not implied by starting either RPC.
      if (method === "question.request" || method === "question.waitAnswer") {
        started[method].resolve();
      }
      return response;
    },
  );
  return {
    mock,
    call: mock as unknown as GatewayCall,
    waitForCall: (method: keyof typeof started) =>
      withTestTimeout(started[method].promise, 1_000, `ask_user did not start ${method}`),
  };
}

function reservePrompt(
  params: Partial<Omit<Parameters<typeof reserveAskUserPromptDelivery>[0], "questions">> = {},
) {
  const reservation = reserveAskUserPromptDelivery({
    toolCallId: TOOL_CALL_ID,
    sessionKey: SESSION_KEY,
    ...params,
    questions: normalizeAskUserParams(validArgs).questions,
  });
  if (!reservation) {
    throw new Error("expected prompt reservation");
  }
  return reservation;
}

function registeredGateway(handlers: RpcHandlers) {
  return gatewayStub({ "question.request": async ({ id }) => ({ id }), ...handlers });
}

function ask(gateway: ReturnType<typeof gatewayStub>, signal?: AbortSignal) {
  return createAskUserTool({ sessionKey: SESSION_KEY, gatewayCall: gateway.call }).execute(
    TOOL_CALL_ID,
    validArgs,
    signal,
  );
}

function expectCancelled(
  gateway: ReturnType<typeof gatewayStub>,
  questionId: string,
  resolvedBy: string,
) {
  expect(gateway.mock).toHaveBeenCalledWith(
    "question.resolve",
    { timeoutMs: 10_000 },
    { id: questionId, cancel: true, resolvedBy },
  );
}

function expectSteered(steer: ReturnType<typeof vi.fn>, text: string, images?: unknown) {
  expect(steer).toHaveBeenCalledWith(
    text,
    images,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

function requestedQuestionId(mock: ReturnType<typeof gatewayStub>["mock"]): string {
  const requestCall = mock.mock.calls.find(([method]) => method === "question.request");
  const questionId = requestCall?.[2].id;
  if (typeof questionId !== "string") {
    throw new Error("question.request did not include an id");
  }
  return questionId;
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("ask_user", () => {
  it("reserves duplicate bare keys independently per agent", () => {
    const research = reservePrompt({
      toolCallId: "call-research",
      sessionKey: "global",
      agentId: "research",
    });
    const ops = reservePrompt({
      toolCallId: "call-ops",
      sessionKey: "global",
      agentId: "ops",
    });

    expect(research).toBeDefined();
    expect(ops).toBeDefined();
    expect(research?.questionId).not.toBe(ops?.questionId);
  });

  it("uses the Gateway record when the executor has isolated runtime state", async () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reservePrompt();
    const gateway = gatewayStub({
      "question.list": async (params) => {
        expect(params).toEqual({});
        return { questions: [{ id: reservation.questionId, status: "pending" }] };
      },
    });

    await expect(waitForAskUserPromptReady(reservation.questionId, gateway.call)).resolves.toEqual(
      questions,
    );
    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(true);
  });

  it("rejects prompt delivery after the Gateway question terminalizes", async () => {
    const reservation = reservePrompt();
    const gateway = gatewayStub({
      "question.list": async () => ({
        questions: [{ id: reservation.questionId, status: "expired" }],
      }),
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(false);
  });

  it("retries a transient Gateway revalidation failure before delivering", async () => {
    const reservation = reservePrompt();
    let attempts = 0;
    const gateway = gatewayStub({
      "question.list": async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary Gateway disconnect");
        }
        return { questions: [{ id: reservation.questionId, status: "pending" }] };
      },
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it("drops a prompt when local terminalization wins during Gateway revalidation", async () => {
    const reservation = reservePrompt();
    const gateway = gatewayStub({
      "question.list": async () => {
        cancelAskUserPromptDelivery(TOOL_CALL_ID, SESSION_KEY);
        return { questions: [{ id: reservation.questionId, status: "pending" }] };
      },
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(false);
  });

  it("expires prompt revalidation while the Gateway lookup remains stalled", async () => {
    vi.useFakeTimers();
    try {
      const reservation = reservePrompt({ timeoutSeconds: 30 });
      const gateway = gatewayStub({ "question.list": async () => await new Promise(() => {}) });

      const pending = isAskUserPromptPending(reservation.questionId, gateway.call);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares prompt readiness across bundled module instances", async () => {
    const runId = "run-split-module";
    const toolCallId = "call-split-module";
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reservePrompt({
      toolCallId,
      runId,
      sessionKey: "agent:main:subscriber-session",
    });
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway({
      "question.waitAnswer": async () => await finishWait.promise,
    });

    vi.resetModules();
    const isolatedModule = await import("./ask-user-tool.js");
    const pending = isolatedModule
      .createAskUserTool({
        runId,
        sessionKey: "agent:main:executor-session",
        gatewayCall: gateway.call,
      })
      .execute(toolCallId, validArgs);
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some(([method]) => method === "question.request")).toBe(true),
    );
    await expect(
      withTestTimeout(
        waitForAskUserPromptReady(reservation.questionId),
        1_000,
        "ask_user prompt readiness did not reach the subscriber module",
      ),
    ).resolves.toEqual(questions);

    settleAskUserPromptDelivery(reservation.questionId);
    finishWait.resolve({
      status: "answered",
      answers: { answers: { deploy_target: ["Production"] } },
    });
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it("returns answered details plus readable answer lines", async () => {
    const answers = { answers: { deploy_target: ["Staging (Recommended)"] } };
    const gateway = gatewayStub({
      "question.request": async (params) => ({ id: params.id, expiresAtMs: Date.now() + 30_000 }),
      "question.waitAnswer": async () => ({ status: "answered", answers }),
    });
    const tool = createAskUserTool({
      agentId: "main",
      sessionKey: "agent:main:main",
      runId: "run-main",
      gatewayCall: gateway.call,
    });

    const result = await tool.execute("call-answered", validArgs);
    const questionId = requestedQuestionId(gateway.mock);

    expect(result.details).toEqual({ status: "answered", answers });
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Deployment t: Staging (Recommended)"),
      }),
    ]);
    expect(gateway.mock).toHaveBeenNthCalledWith(
      1,
      "question.request",
      {},
      expect.objectContaining({
        id: questionId,
        agentId: "main",
        sessionKey: "agent:main:main",
        runId: "run-main",
        timeoutMs: 900_000,
      }),
      undefined,
    );
    expect(gateway.mock).toHaveBeenNthCalledWith(
      2,
      "question.waitAnswer",
      { timeoutMs: 910_000 },
      { id: questionId, timeoutMs: 900_000, includeResolutionId: true },
      undefined,
    );
  });

  it("publishes its own prompt when no harness reserved one", async () => {
    const answers = { answers: { deploy_target: ["Production"] } };
    const sent: SentPrompt[] = [];
    const promptIsOut = createDeferred();
    const gateway = registeredGateway({
      "question.waitAnswer": async () => {
        await promptIsOut.promise;
        return { status: "answered", answers };
      },
    });

    const result = await createAskUserTool({
      sessionKey: "agent:main:direct-dispatch",
      gatewayCall: gateway.call,
      questionPrompt: {
        send: (payload) => {
          sent.push(payload);
          promptIsOut.resolve();
        },
      },
    }).execute("call-direct-dispatch", validArgs);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelData).toMatchObject({
      askUser: { questionId: requestedQuestionId(gateway.mock) },
    });
    expect(sent[0]?.text).toContain("Where should this deploy?");
    expect(result.details).toEqual({ status: "answered", answers });
  });

  it.each(["answered", "pending"] as const)(
    "ends self-publication when the Gateway returns %s before delivery",
    async (status) => {
      const answers = { answers: { deploy_target: ["Production"] } };
      const result = status === "answered" ? { status, answers } : { status };
      const finishWait = createDeferred<typeof result>();
      const promptStarted = createDeferred();
      let aborted = false;
      const gateway = registeredGateway({
        "question.waitAnswer": async () => finishWait.promise,
        "question.resolve": async () => ({ status: "cancelled" }),
      });
      const pending = createAskUserTool({
        sessionKey: "agent:main:direct-dispatch-abort",
        gatewayCall: gateway.call,
        questionPrompt: {
          send: (_payload, options) => {
            options?.signal?.addEventListener("abort", () => (aborted = true), { once: true });
            promptStarted.resolve();
            return new Promise<void>(() => {});
          },
        },
      }).execute("call-direct-dispatch-abort", validArgs);
      await promptStarted.promise;
      finishWait.resolve(result);
      await expect(pending).resolves.toMatchObject({
        details: status === "answered" ? { status, answers } : { status: "no_answer" },
      });
      expect(aborted).toBe(true);
    },
  );

  it("leaves the prompt to a harness that already reserved one", async () => {
    const sessionKey = "agent:main:reserved-prompt";
    const normalized = normalizeAskUserParams(validArgs);
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-reserved",
      sessionKey,
      questions: normalized.questions,
      timeoutSeconds: normalized.timeoutSeconds,
    });
    const sent: SentPrompt[] = [];
    const gateway = registeredGateway({
      "question.waitAnswer": async () => ({ status: "expired" }),
    });

    const result = await createAskUserTool({
      sessionKey,
      gatewayCall: gateway.call,
      questionPrompt: {
        send: (payload) => {
          sent.push(payload);
        },
      },
    }).execute("call-reserved", validArgs);

    expect(reservation).toBeDefined();
    expect(sent).toEqual([]);
    expect(result.details).toEqual({ status: "no_answer" });
  });

  it.each([
    ["expired", "No answer arrived"],
    ["pending", "No answer arrived"],
    ["cancelled", "question was cancelled"],
  ] as const)("maps %s to no_answer", async (status, text) => {
    const gateway = registeredGateway({
      "question.waitAnswer": async () => ({ status }),
      "question.resolve": async () => ({ status }),
    });
    const result = await createAskUserTool({
      sessionKey: `agent:main:${status}`,
      gatewayCall: gateway.call,
    }).execute(`call-${status}`, validArgs);
    const questionId = requestedQuestionId(gateway.mock);

    expect(result.details).toEqual({ status: "no_answer" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(text) });
    if (status === "pending") {
      expect(gateway.mock).toHaveBeenCalledWith(
        "question.resolve",
        { timeoutMs: 10_000 },
        { id: questionId, cancel: true, resolvedBy: "wait-timeout" },
      );
    }
  });

  it("rejects a second pending question in the same session", async () => {
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway({
      "question.waitAnswer": async () => await finishWait.promise,
      "question.resolve": async () => {
        finishWait.resolve({ status: "cancelled" });
        return { status: "cancelled" };
      },
    });
    const tool = createAskUserTool({
      sessionKey: "agent:main:serialized",
      gatewayCall: gateway.call,
    });
    const first = tool.execute("call-first", validArgs);
    await gateway.waitForCall("question.waitAnswer");

    await expect(tool.execute("call-second", validArgs)).rejects.toThrow(
      "already has a pending question",
    );
    finishWait.resolve({ status: "cancelled" });
    await expect(first).resolves.toMatchObject({ details: { status: "no_answer" } });
  });

  it.each([
    ["question.waitAnswer", "aborted"],
    ["question.request", "registration aborted"],
  ] as const)("cancels the Gateway question when abort interrupts %s", async (method, message) => {
    const controller = new AbortController();
    const blocked: RpcHandlers[string] = async (_params, extra) =>
      new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(new Error(message)), { once: true });
      });
    const gateway = gatewayStub({
      "question.request": method === "question.request" ? blocked : async ({ id }) => ({ id }),
      "question.waitAnswer": blocked,
      "question.resolve": async () => ({ status: "cancelled" }),
    });
    const pending = ask(gateway, controller.signal);
    await gateway.waitForCall(method);
    expect(gateway.mock.mock.calls.some((call) => call[0] === method)).toBe(true);
    const questionId = requestedQuestionId(gateway.mock);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow(message);
    expectCancelled(gateway, questionId, "run-abort");
  });

  it("does not activate prompt delivery when registration ignores an earlier abort", async () => {
    const reservation = reservePrompt();
    const finishRegistration = createDeferred<unknown>();
    const gateway = gatewayStub({
      "question.request": async () => await finishRegistration.promise,
      "question.resolve": async () => ({ status: "cancelled" }),
    });
    const controller = new AbortController();
    const pending = ask(gateway, controller.signal);
    await gateway.waitForCall("question.request");

    controller.abort(new Error("stop before registration completed"));
    finishRegistration.resolve({ id: reservation.questionId });

    await expect(pending).rejects.toThrow("stop before registration completed");
    expect(reservePrompt({ toolCallId: "call-after-late-registration-abort" })).toBeDefined();
  });

  it("suppresses a stale prompt when an image arrives during registration", async () => {
    const finishRegistration = createDeferred<unknown>();
    let resolveCount = 0;
    const gateway = gatewayStub({
      "question.request": async () => await finishRegistration.promise,
      "question.resolve": async () => {
        resolveCount += 1;
        if (resolveCount === 1) {
          throw Object.assign(new Error("not registered yet"), {
            name: "GatewayClientRequestError",
            details: { reason: "QUESTION_NOT_FOUND" },
          });
        }
        return { status: "cancelled" };
      },
    });
    const pending = ask(gateway);
    await gateway.waitForCall("question.request");
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Use this image",
      { isInboundUserMessage: true, images: IMAGE_REPLY },
      SESSION_KEY,
    );
    finishRegistration.resolve({ id: questionId });

    expectSteered(steer, "Use this image", IMAGE_REPLY);
    await expect(pending).resolves.toMatchObject({ details: { status: "no_answer" } });
    expect(
      gateway.mock.mock.calls.filter(([method]) => method === "question.resolve"),
    ).toHaveLength(2);
    expect(gateway.mock.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
      false,
    );
  });

  it("best-effort cancels a deterministic id after an ambiguous registration failure", async () => {
    const gateway = gatewayStub({
      "question.request": async () => {
        throw new Error("connection lost after send");
      },
      "question.resolve": async () => ({ status: "cancelled" }),
    });

    await expect(ask(gateway)).rejects.toThrow("connection lost after send");
    const questionId = requestedQuestionId(gateway.mock);
    expectCancelled(gateway, questionId, "registration-failed");
  });

  it("terminates when a separately loaded dispatcher reports visible control failure", async () => {
    const reservation = reservePrompt();
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway({
      "question.waitAnswer": async () => await finishWait.promise,
      "question.resolve": async () => {
        finishWait.resolve({ status: "cancelled" });
        return { status: "cancelled" };
      },
    });
    const pending = ask(gateway);
    await gateway.waitForCall("question.waitAnswer");

    const foreignModule = (await import(
      `${replyDispatchOutcomeModuleUrl}?instance=ask-user-foreign`
    )) as typeof import("../../auto-reply/reply/reply-dispatch-outcome.js");
    const deliveryError = new foreignModule.ReplyDispatchDeliveryError("failed-deliver");
    expect(deliveryError).not.toBeInstanceOf(ReplyDispatchDeliveryError);
    settleAskUserPromptDelivery(reservation.questionId, deliveryError);

    await expect(pending).resolves.toMatchObject({
      terminate: true,
      details: { status: "delivery_failed" },
      content: [expect.objectContaining({ text: expect.stringMatching(/no retry\/fallback/i) })],
    });
    expectCancelled(gateway, reservation.questionId, "prompt-delivery-failed");
    expect(gateway.mock.mock.calls.some((call) => call[0] === "question.waitAnswer")).toBe(true);
  });

  it("preserves an answer that wins the prompt-failure cancellation race", async () => {
    const reservation = reservePrompt();
    const answers = { answers: { deploy_target: ["Production"] } };
    let waitCalls = 0;
    const gateway = registeredGateway({
      "question.waitAnswer": async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          return await new Promise<unknown>(() => {});
        }
        return { status: "answered", answers };
      },
      "question.resolve": async () => {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      },
    });
    const pending = ask(gateway);
    await vi.waitFor(() => expect(waitCalls).toBe(1));

    settleAskUserPromptDelivery(
      reservation.questionId,
      new ReplyDispatchDeliveryError("failed-deliver"),
    );

    await expect(pending).resolves.toMatchObject({ details: { status: "answered", answers } });
    expect(waitCalls).toBe(2);
  });

  it("aborts while prompt delivery is still pending", async () => {
    const reservation = reservePrompt();
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway({
      "question.waitAnswer": async (_params, extra) => {
        return await new Promise((resolve, reject) => {
          void finishWait.promise.then(resolve, reject);
          extra?.signal?.addEventListener("abort", () => reject(new Error("wait aborted")), {
            once: true,
          });
        });
      },
      "question.resolve": async () => {
        finishWait.resolve({ status: "cancelled" });
        return { status: "cancelled" };
      },
    });
    const controller = new AbortController();
    const pending = ask(gateway, controller.signal);
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some((call) => call[0] === "question.request")).toBe(true),
    );

    controller.abort(new Error("stop during delivery"));

    await expect(pending).rejects.toThrow("stop during delivery");
    expect(reservePrompt({ toolCallId: "call-after-delivery-abort" })).toBeDefined();
    expectCancelled(gateway, reservation.questionId, "run-abort");
  });

  it("claims unmatched plain text as free text without steering it into the run", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = registeredGateway({
      "question.waitAnswer": async () => {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      },
      "question.resolve": async (params) => {
        const answers = params.answers;
        finishWait?.({ status: "answered", answers });
        return { status: "answered", answers };
      },
    });
    const pending = createAskUserTool({
      sessionKey: "agent:main:claim",
      gatewayCall: gateway.call,
    }).execute("call-claim", validArgs);
    await gateway.waitForCall("question.waitAnswer");
    expect(finishWait).toBeTypeOf("function");
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);
    const activeSession = { steer, subscribe: vi.fn(() => () => undefined) };
    const persistApproved = vi.fn(async () => undefined);
    const recorder = { persistApproved } as unknown as UserTurnTranscriptRecorder;

    await steerActiveSessionWithOptionalDeliveryWait(
      activeSession,
      "A custom destination",
      {
        isInboundUserMessage: true,
        waitForTranscriptCommit: true,
        userTurnTranscriptRecorder: recorder,
      },
      "agent:main:claim",
    );

    expect(steer).not.toHaveBeenCalled();
    expect(persistApproved).toHaveBeenCalledOnce();
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.resolve",
      {},
      {
        id: questionId,
        answers: { answers: { deploy_target: ["A custom destination"] } },
        resolvedBy: "plain-text",
        resolutionId: expect.stringMatching(/^[a-f0-9]{32}$/),
      },
    );
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it.each([
    ["cancellation succeeds", false],
    ["cancellation fails", true],
  ])("keeps image replies on normal steering when %s", async (_name, cancelFails) => {
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway({
      "question.waitAnswer": async () => await finishWait.promise,
      "question.resolve": async (params) => {
        if ("cancel" in params) {
          if (cancelFails) {
            throw new Error("gateway unavailable");
          }
          finishWait.resolve({ status: "cancelled" });
          return { status: "cancelled" };
        }
        const result = { status: "answered", answers: params.answers };
        finishWait.resolve(result);
        return result;
      },
    });
    const pending = ask(gateway);
    await gateway.waitForCall("question.waitAnswer");
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Use this image",
      { isInboundUserMessage: true, images: IMAGE_REPLY },
      SESSION_KEY,
    );

    expectSteered(steer, "Use this image", IMAGE_REPLY);
    expectCancelled(gateway, questionId, "image-reply");
    if (cancelFails) {
      const followUpSteer = vi.fn(async () => undefined);
      await steerActiveSessionWithOptionalDeliveryWait(
        { steer: followUpSteer, subscribe: vi.fn(() => () => undefined) },
        "Follow-up after image",
        { isInboundUserMessage: true },
        SESSION_KEY,
      );
      expect(followUpSteer).not.toHaveBeenCalled();
    }
    await expect(pending).resolves.toMatchObject({
      details: { status: cancelFails ? "answered" : "no_answer" },
    });
  });

  it("confirms a committed plain-text answer after its resolve response is lost", async () => {
    const finishWait = createDeferred<unknown>();
    let committedAnswer: unknown;
    const gateway = registeredGateway({
      "question.waitAnswer": async (params) => {
        expect(params.includeResolutionId).toBe(true);
        if (committedAnswer) {
          return committedAnswer;
        }
        return await finishWait.promise;
      },
      "question.resolve": async (params) => {
        committedAnswer = {
          status: "answered",
          answers: params.answers,
          resolutionId: params.resolutionId,
        };
        finishWait.resolve(committedAnswer);
        throw new Error("response lost after commit");
      },
    });
    const pending = ask(gateway);
    await gateway.waitForCall("question.waitAnswer");
    const steer = vi.fn(async () => undefined);
    const persistApproved = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "1",
      {
        isInboundUserMessage: true,
        userTurnTranscriptRecorder: { persistApproved } as unknown as UserTurnTranscriptRecorder,
      },
      SESSION_KEY,
    );

    expect(steer).not.toHaveBeenCalled();
    expect(persistApproved).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it("falls back to normal steering when the gateway question is already terminal", async () => {
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway({
      "question.waitAnswer": async () => await finishWait.promise,
      "question.resolve": async () => {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      },
    });
    const pending = ask(gateway);
    await gateway.waitForCall("question.waitAnswer");
    const steer = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Follow-up message",
      { isInboundUserMessage: true },
      SESSION_KEY,
    );

    expectSteered(steer, "Follow-up message");
    finishWait.resolve({ status: "cancelled" });
    await pending;
  });
});
