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

function gatewayStub(
  implementation: (
    method: string,
    opts: Record<string, unknown>,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<unknown>,
) {
  const started = {
    "question.request": createDeferred(),
    "question.waitAnswer": createDeferred(),
  };
  const mock = vi.fn((...args: Parameters<typeof implementation>) => {
    const response = implementation(...args);
    const [method] = args;
    // Callback setup has completed, but the owner's later prompt-delivery phase
    // is not implied by starting either RPC.
    if (method === "question.request" || method === "question.waitAnswer") {
      started[method].resolve();
    }
    return response;
  });
  return {
    mock,
    call: mock as unknown as GatewayCall,
    waitForCall: (method: keyof typeof started) =>
      withTestTimeout(started[method].promise, 1_000, `ask_user did not start ${method}`),
  };
}

function reservePrompt(
  params: Omit<Parameters<typeof reserveAskUserPromptDelivery>[0], "questions">,
) {
  const reservation = reserveAskUserPromptDelivery({
    ...params,
    questions: normalizeAskUserParams(validArgs).questions,
  });
  if (!reservation) {
    throw new Error("expected prompt reservation");
  }
  return reservation;
}

function registeredGateway(implementation: Parameters<typeof gatewayStub>[0]) {
  return gatewayStub(async (method, opts, params, extra) =>
    method === "question.request" ? { id: params.id } : implementation(method, opts, params, extra),
  );
}

function ask(
  gateway: ReturnType<typeof gatewayStub>,
  sessionKey: string,
  toolCallId: string,
  signal?: AbortSignal,
) {
  return createAskUserTool({ sessionKey, gatewayCall: gateway.call }).execute(
    toolCallId,
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

describe("ask_user prompt delivery", () => {
  it("reserves duplicate bare keys independently per agent", () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const research = reserveAskUserPromptDelivery({
      toolCallId: "call-research",
      sessionKey: "global",
      agentId: "research",
      questions,
    });
    const ops = reserveAskUserPromptDelivery({
      toolCallId: "call-ops",
      sessionKey: "global",
      agentId: "ops",
      questions,
    });

    expect(research).toBeDefined();
    expect(ops).toBeDefined();
    expect(research?.questionId).not.toBe(ops?.questionId);
  });

  it("uses the Gateway record when the executor has isolated runtime state", async () => {
    const questions = normalizeAskUserParams(validArgs).questions;
    const reservation = reservePrompt({
      toolCallId: "call-isolated-runtime",
      sessionKey: "agent:main:isolated-runtime",
    });
    const gateway = gatewayStub(async (method, _opts, params) => {
      expect(method).toBe("question.list");
      expect(params).toEqual({});
      return { questions: [{ id: reservation.questionId, status: "pending" }] };
    });

    await expect(waitForAskUserPromptReady(reservation.questionId, gateway.call)).resolves.toEqual(
      questions,
    );
    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(true);
  });

  it("rejects prompt delivery after the Gateway question terminalizes", async () => {
    const reservation = reservePrompt({
      toolCallId: "call-terminal-before-delivery",
      sessionKey: "agent:main:terminal-before-delivery",
    });
    const gateway = gatewayStub(async () => ({
      questions: [{ id: reservation.questionId, status: "expired" }],
    }));

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(false);
  });

  it("retries a transient Gateway revalidation failure before delivering", async () => {
    const reservation = reservePrompt({
      toolCallId: "call-revalidation-failure",
      sessionKey: "agent:main:revalidation-failure",
    });
    let attempts = 0;
    const gateway = gatewayStub(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary Gateway disconnect");
      }
      return { questions: [{ id: reservation.questionId, status: "pending" }] };
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it("drops a prompt when local terminalization wins during Gateway revalidation", async () => {
    const toolCallId = "call-revalidation-terminal";
    const sessionKey = "agent:main:revalidation-terminal";
    const reservation = reservePrompt({ toolCallId, sessionKey });
    const gateway = gatewayStub(async () => {
      cancelAskUserPromptDelivery(toolCallId, sessionKey);
      return { questions: [{ id: reservation.questionId, status: "pending" }] };
    });

    await expect(isAskUserPromptPending(reservation.questionId, gateway.call)).resolves.toBe(false);
  });

  it("expires prompt revalidation while the Gateway lookup remains stalled", async () => {
    vi.useFakeTimers();
    try {
      const reservation = reservePrompt({
        toolCallId: "call-revalidation-stalled",
        sessionKey: "agent:main:revalidation-stalled",
        timeoutSeconds: 30,
      });
      const gateway = gatewayStub(async () => await new Promise(() => {}));

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
    const gateway = registeredGateway(async (method, _opts, _params) => {
      if (method === "question.waitAnswer") {
        return await finishWait.promise;
      }
      throw new Error(`unexpected method ${method}`);
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
});

describe("ask_user execution", () => {
  it("returns answered details plus readable answer lines", async () => {
    const answers = { answers: { deploy_target: ["Staging (Recommended)"] } };
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id, expiresAtMs: Date.now() + 30_000 };
      }
      if (method === "question.waitAnswer") {
        return { status: "answered", answers };
      }
      throw new Error(`unexpected method ${method}`);
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
    let promptDelivered: () => void = () => {};
    const promptIsOut = new Promise<void>((resolve) => {
      promptDelivered = resolve;
    });
    const gateway = registeredGateway(async (method, _opts, _params) => {
      if (method === "question.waitAnswer") {
        await promptIsOut;
        return { status: "answered", answers };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const result = await createAskUserTool({
      sessionKey: "agent:main:direct-dispatch",
      gatewayCall: gateway.call,
      questionPrompt: {
        send: (payload) => {
          sent.push(payload);
          promptDelivered();
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
      const gateway = gatewayStub(async (method, _opts, params) =>
        method === "question.request"
          ? { id: params.id }
          : method === "question.waitAnswer"
            ? finishWait.promise
            : method === "question.resolve"
              ? { status: "cancelled" }
              : Promise.reject(new Error(`unexpected method ${method}`)),
      );
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
    const gateway = gatewayStub(async (method, _opts, params) =>
      method === "question.request" ? { id: params.id } : { status: "expired" },
    );

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
    const gateway = gatewayStub(async (method, _opts, params) =>
      method === "question.request" ? { id: params.id } : { status },
    );
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
    const gateway = registeredGateway(async (method, _opts, _params) => {
      if (method === "question.waitAnswer") {
        return await finishWait.promise;
      }
      if (method === "question.resolve") {
        finishWait.resolve({ status: "cancelled" });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
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

  it("cancels the gateway question when the run aborts", async () => {
    const controller = new AbortController();
    const gateway = registeredGateway(async (method, _opts, _params, extra) => {
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      return await new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const pending = ask(gateway, "agent:main:abort", "call-abort", controller.signal);
    await gateway.waitForCall("question.waitAnswer");
    expect(gateway.mock.mock.calls.some((call) => call[0] === "question.waitAnswer")).toBe(true);
    const questionId = requestedQuestionId(gateway.mock);

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("aborted");
    expectCancelled(gateway, questionId, "run-abort");
  });

  it("aborts registration and still attempts gateway cancellation", async () => {
    const controller = new AbortController();
    const gateway = gatewayStub(async (method, _opts, _params, extra) => {
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      return await new Promise((_resolve, reject) => {
        extra?.signal?.addEventListener("abort", () => reject(new Error("registration aborted")), {
          once: true,
        });
      });
    });
    const pending = ask(
      gateway,
      "agent:main:register-abort",
      "call-register-abort",
      controller.signal,
    );
    await gateway.waitForCall("question.request");
    expect(gateway.mock.mock.calls.some((call) => call[0] === "question.request")).toBe(true);
    const questionId = requestedQuestionId(gateway.mock);

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("registration aborted");
    expectCancelled(gateway, questionId, "run-abort");
  });

  it("does not activate prompt delivery when registration ignores an earlier abort", async () => {
    const sessionKey = "agent:main:late-registration-abort";
    const reservation = reservePrompt({
      toolCallId: "call-late-registration-abort",
      sessionKey,
    });
    const finishRegistration = createDeferred<unknown>();
    const gateway = gatewayStub(async (method) => {
      if (method === "question.request") {
        return await finishRegistration.promise;
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const controller = new AbortController();
    const pending = ask(gateway, sessionKey, "call-late-registration-abort", controller.signal);
    await gateway.waitForCall("question.request");

    controller.abort(new Error("stop before registration completed"));
    finishRegistration.resolve({ id: reservation.questionId });

    await expect(pending).rejects.toThrow("stop before registration completed");
    expect(
      reserveAskUserPromptDelivery({
        toolCallId: "call-after-late-registration-abort",
        sessionKey,
        questions: normalizeAskUserParams(validArgs).questions,
      }),
    ).toBeDefined();
  });

  it("suppresses a stale prompt when an image arrives during registration", async () => {
    const finishRegistration = createDeferred<unknown>();
    let resolveCount = 0;
    const gateway = gatewayStub(async (method) => {
      if (method === "question.request") {
        return await finishRegistration.promise;
      }
      if (method === "question.resolve") {
        resolveCount += 1;
        if (resolveCount === 1) {
          throw Object.assign(new Error("not registered yet"), {
            name: "GatewayClientRequestError",
            details: { reason: "QUESTION_NOT_FOUND" },
          });
        }
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const sessionKey = "agent:main:register-image";
    const pending = ask(gateway, sessionKey, "call-register-image");
    await gateway.waitForCall("question.request");
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);
    const images = [{ type: "image" as const, data: "pixels", mimeType: "image/png" }];

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Use this image",
      { isInboundUserMessage: true, images },
      sessionKey,
    );
    finishRegistration.resolve({ id: questionId });

    expectSteered(steer, "Use this image", images);
    await expect(pending).resolves.toMatchObject({ details: { status: "no_answer" } });
    expect(
      gateway.mock.mock.calls.filter(([method]) => method === "question.resolve"),
    ).toHaveLength(2);
    expect(gateway.mock.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
      false,
    );
  });

  it("best-effort cancels a deterministic id after an ambiguous registration failure", async () => {
    const sessionKey = "agent:main:registration-loss";
    const gateway = gatewayStub(async (method) => {
      if (method === "question.request") {
        throw new Error("connection lost after send");
      }
      if (method === "question.resolve") {
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    await expect(ask(gateway, sessionKey, "call-registration-loss")).rejects.toThrow(
      "connection lost after send",
    );
    const questionId = requestedQuestionId(gateway.mock);
    expectCancelled(gateway, questionId, "registration-failed");
  });

  it("terminates when a separately loaded dispatcher reports visible control failure", async () => {
    const sessionKey = "agent:main:delivery-failure";
    const reservation = reservePrompt({
      toolCallId: "call-delivery-failure",
      sessionKey,
    });
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway(async (method, _opts, _params) => {
      if (method === "question.waitAnswer") {
        return await finishWait.promise;
      }
      if (method === "question.resolve") {
        finishWait.resolve({ status: "cancelled" });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = ask(gateway, sessionKey, "call-delivery-failure");
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
    const sessionKey = "agent:main:delivery-answer-race";
    const reservation = reservePrompt({
      toolCallId: "call-delivery-answer-race",
      sessionKey,
    });
    const answers = { answers: { deploy_target: ["Production"] } };
    let waitCalls = 0;
    const gateway = registeredGateway(async (method, _opts, _params) => {
      if (method === "question.waitAnswer") {
        waitCalls += 1;
        if (waitCalls === 1) {
          return await new Promise<unknown>(() => {});
        }
        return { status: "answered", answers };
      }
      if (method === "question.resolve") {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = ask(gateway, sessionKey, "call-delivery-answer-race");
    await vi.waitFor(() => expect(waitCalls).toBe(1));

    settleAskUserPromptDelivery(
      reservation.questionId,
      new ReplyDispatchDeliveryError("failed-deliver"),
    );

    await expect(pending).resolves.toMatchObject({ details: { status: "answered", answers } });
    expect(waitCalls).toBe(2);
  });

  it("aborts while prompt delivery is still pending", async () => {
    const sessionKey = "agent:main:delivery-abort";
    const reservation = reservePrompt({
      toolCallId: "call-delivery-abort",
      sessionKey,
    });
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway(async (method, _opts, _params, extra) => {
      if (method === "question.waitAnswer") {
        return await new Promise((resolve, reject) => {
          void finishWait.promise.then(resolve, reject);
          extra?.signal?.addEventListener("abort", () => reject(new Error("wait aborted")), {
            once: true,
          });
        });
      }
      if (method === "question.resolve") {
        finishWait.resolve({ status: "cancelled" });
        return { status: "cancelled" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const controller = new AbortController();
    const pending = ask(gateway, sessionKey, "call-delivery-abort", controller.signal);
    await vi.waitFor(() =>
      expect(gateway.mock.mock.calls.some((call) => call[0] === "question.request")).toBe(true),
    );

    controller.abort(new Error("stop during delivery"));

    await expect(pending).rejects.toThrow("stop during delivery");
    expect(
      reserveAskUserPromptDelivery({
        toolCallId: "call-after-delivery-abort",
        sessionKey,
        questions: normalizeAskUserParams(validArgs).questions,
      }),
    ).toBeDefined();
    expectCancelled(gateway, reservation.questionId, "run-abort");
  });

  it("claims unmatched plain text as free text without steering it into the run", async () => {
    let finishWait: ((value: unknown) => void) | undefined;
    const gateway = gatewayStub(async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: params.id };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          finishWait = resolve;
        });
      }
      if (method === "question.resolve") {
        const answers = params.answers;
        finishWait?.({ status: "answered", answers });
        return { status: "answered", answers };
      }
      throw new Error(`unexpected method ${method}`);
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
    const gateway = registeredGateway(async (method, _opts, params) => {
      if (method === "question.waitAnswer") {
        return await finishWait.promise;
      }
      if (method === "question.resolve") {
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
      }
      throw new Error(`unexpected method ${method}`);
    });
    const suffix = cancelFails ? "image-cancel-failure" : "image-reply";
    const sessionKey = `agent:main:${suffix}`;
    const pending = ask(gateway, sessionKey, `call-${suffix}`);
    await gateway.waitForCall("question.waitAnswer");
    const questionId = requestedQuestionId(gateway.mock);
    const steer = vi.fn(async () => undefined);
    const images = [{ type: "image" as const, data: "pixels", mimeType: "image/png" }];

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Use this image",
      { isInboundUserMessage: true, images },
      sessionKey,
    );

    expectSteered(steer, "Use this image", images);
    expectCancelled(gateway, questionId, "image-reply");
    if (cancelFails) {
      const followUpSteer = vi.fn(async () => undefined);
      await steerActiveSessionWithOptionalDeliveryWait(
        { steer: followUpSteer, subscribe: vi.fn(() => () => undefined) },
        "Follow-up after image",
        { isInboundUserMessage: true },
        sessionKey,
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
    const gateway = registeredGateway(async (method, _opts, params) => {
      if (method === "question.waitAnswer") {
        expect(params.includeResolutionId).toBe(true);
        if (committedAnswer) {
          return committedAnswer;
        }
        return await finishWait.promise;
      }
      if (method === "question.resolve") {
        committedAnswer = {
          status: "answered",
          answers: params.answers,
          resolutionId: params.resolutionId,
        };
        finishWait.resolve(committedAnswer);
        throw new Error("response lost after commit");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const sessionKey = "agent:main:resolve-loss";
    const pending = ask(gateway, sessionKey, "call-resolve-loss");
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
      sessionKey,
    );

    expect(steer).not.toHaveBeenCalled();
    expect(persistApproved).toHaveBeenCalledOnce();
    await expect(pending).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it("falls back to normal steering when the gateway question is already terminal", async () => {
    const finishWait = createDeferred<unknown>();
    const gateway = registeredGateway(async (method, _opts, _params) => {
      if (method === "question.waitAnswer") {
        return await finishWait.promise;
      }
      if (method === "question.resolve") {
        throw Object.assign(new Error("already answered"), {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ALREADY_TERMINAL" },
        });
      }
      throw new Error(`unexpected method ${method}`);
    });
    const pending = ask(gateway, "agent:main:terminal-race", "call-terminal-race");
    await gateway.waitForCall("question.waitAnswer");
    const steer = vi.fn(async () => undefined);

    await steerActiveSessionWithOptionalDeliveryWait(
      { steer, subscribe: vi.fn(() => () => undefined) },
      "Follow-up message",
      { isInboundUserMessage: true },
      "agent:main:terminal-race",
    );

    expectSteered(steer, "Follow-up message");
    finishWait.resolve({ status: "cancelled" });
    await pending;
  });
});
