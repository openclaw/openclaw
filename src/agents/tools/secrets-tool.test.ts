import assert from "node:assert/strict";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  QuestionRequestParamsSchema,
  QuestionResolveParamsSchema,
  QuestionWaitAnswerParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SecretRefSchema } from "../../config/zod-schema.core.js";
import { QuestionManager, QuestionManagerError } from "../../gateway/question-manager.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../infra/embedded-mode.js";
import {
  EmbeddedQuestionBroker,
  clearEmbeddedQuestionBroker,
  setEmbeddedQuestionBroker,
} from "../../infra/embedded-question-broker.js";
import { isBuiltInDefaultSecretProviderRef } from "../../secrets/ref-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import * as questionDispatch from "../harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswer } from "../harness/gateway-question.js";
import { wrapToolDefinition } from "../sessions/tools/tool-definition-wrapper.js";
import {
  cancelAskUserPromptDelivery,
  reserveAskUserPromptDelivery,
  settleAskUserPromptDelivery,
} from "./ask-user-tool.js";
import type { GatewayQuestionCall } from "./gateway-question-lifecycle.js";
import * as gatewayTransport from "./gateway.js";
import { createSecretsTool, normalizeSecretsRequestParams } from "./secrets-tool.js";

type GatewayCall = GatewayQuestionCall;
type GatewayImplementation = (
  method: string,
  opts: Record<string, unknown>,
  params: Record<string, unknown>,
  extra?: { signal?: AbortSignal; requireAgentRuntimeIdentity?: boolean },
) => Promise<unknown>;

function gatewayStub(implementation: GatewayImplementation) {
  const mock = vi.fn(implementation);
  return { mock, call: mock as unknown as GatewayCall };
}

function questionManagerGateway(
  manager: QuestionManager,
  onRequest: (request: Parameters<QuestionManager["request"]>[0]) => unknown,
) {
  return gatewayStub(async (method, _options, params) => {
    try {
      if (method === "question.request") {
        const request = Value.Parse(QuestionRequestParamsSchema, params);
        return onRequest({ ...request, timeoutMs: request.timeoutMs ?? 60_000 });
      }
      if (method === "question.resolve") {
        const request = Value.Parse(QuestionResolveParamsSchema, params);
        if (!("cancel" in request)) {
          throw new Error("expected question cancellation");
        }
        return manager.cancel(request.id, request.resolvedBy);
      }
      if (method === "question.waitAnswer") {
        const request = Value.Parse(QuestionWaitAnswerParamsSchema, params);
        return manager.waitAnswer(request.id, request.timeoutMs);
      }
      throw new Error(`unexpected method ${method}`);
    } catch (error) {
      if (error instanceof QuestionManagerError) {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: error.message,
          details: { reason: error.code },
        });
      }
      throw error;
    }
  });
}

function requestedQuestionId(mock: ReturnType<typeof gatewayStub>["mock"]): string {
  const request = mock.mock.calls.find(([method]) => method === "question.request");
  const questionId = request?.[2].id;
  if (typeof questionId !== "string") {
    throw new Error("question.request did not include an id");
  }
  return questionId;
}

const secretName = "SERVICE_API_KEY";
const storedAnswer = { status: "answered", answers: { answers: { secret_value: ["stored"] } } };
const secretRequest = { action: "request", name: secretName, kind: "secret" };
const proposedBinding = {
  name: secretName,
  kind: "secret",
  allowedHosts: ["api.example.test"],
  reason: "Deploy the service",
};
const proposedRequest = { action: "request", ...proposedBinding };
const secretQuestion = {
  questionId: "secret_value",
  header: "API key",
  question: "Provide the secret for SERVICE_API_KEY.",
  options: [],
  isSecret: true,
  secretStore: proposedBinding,
};
const questions = normalizeSecretsRequestParams(secretRequest).questions;
const storedMethods = ["question.request", "question.waitAnswer", "secrets.store.list"];

function reservePrompt(toolCallId: string, sessionKey: string) {
  const reservation = reserveAskUserPromptDelivery({
    toolCallId,
    sessionKey,
    questions,
    timeoutSeconds: 900,
  });
  if (reservation) {
    onTestFinished(() => cancelAskUserPromptDelivery(toolCallId, sessionKey));
  }
  return reservation;
}

function outcome<T>(pending: Promise<T>) {
  return pending.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

function settleOnCleanup(pending: Promise<unknown>, release: () => void) {
  const settled = Promise.allSettled([pending]);
  onTestFinished(async () => {
    release();
    await settled;
  });
}
let storeTransportSpy: MockInstance<typeof gatewayTransport.callGatewayTool> | undefined;
let questionResolverSpy:
  | MockInstance<typeof questionDispatch.resolveAgentQuestionGatewayCall>
  | undefined;

function secretTool(
  gateway: ReturnType<typeof gatewayStub>,
  options: Parameters<typeof createSecretsTool>[0] = {},
) {
  storeTransportSpy = vi
    .spyOn(gatewayTransport, "callGatewayTool")
    .mockImplementation(gateway.call);
  questionResolverSpy = vi
    .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
    .mockReturnValue(gateway.call);
  return createSecretsTool(options);
}

function methodCalls(gateway: ReturnType<typeof gatewayStub>, method: string) {
  return gateway.mock.mock.calls.filter(([called]) => called === method);
}
function expectCancellation(gateway: ReturnType<typeof gatewayStub>, resolvedBy: string) {
  expect(gateway.mock).toHaveBeenCalledWith(
    "question.resolve",
    { timeoutMs: 10_000 },
    { id: requestedQuestionId(gateway.mock), cancel: true, resolvedBy },
  );
}
const storeMetadata = {
  name: secretName,
  createdAtMs: 0,
  updatedAtMs: 0,
  scopeKind: "team",
  scopeId: "",
};
const editedPolicy = { status: "available", allowedHosts: ["api.analytics.example"] };
const secretEntry = { ...storeMetadata, kind: "secret", allowedHosts: editedPolicy.allowedHosts };
const unrelatedEnv = {
  ...storeMetadata,
  name: "UNRELATED_ENV",
  kind: "env",
  value: "private-env-value",
};

function requestGateway(handlers: Record<string, GatewayImplementation | undefined>) {
  return gatewayStub(async (method, _options, params, extra) => {
    if (method === "question.request") {
      return { id: params.id };
    }
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`unexpected method ${method}`);
    }
    return handler(method, _options, params, extra);
  });
}

function storedRequestGateway(readMetadata: () => Promise<unknown>) {
  return requestGateway({
    "question.waitAnswer": async () => storedAnswer,
    "secrets.store.list": readMetadata,
  });
}

function waitingStoredRequestGateway(allowMetadata = true) {
  const answer = createDeferred<unknown>();
  const waiting = createDeferred();
  const gateway = requestGateway({
    "question.waitAnswer": async () => {
      waiting.resolve();
      return await answer.promise;
    },
    "secrets.store.list": allowMetadata
      ? async () => ({ entries: [unrelatedEnv, secretEntry] })
      : undefined,
  });
  return { gateway, answer, waiting: waiting.promise };
}

function expectStoredDetails(details: unknown, currentPolicy: unknown, provider = "default") {
  expect(details).toEqual({
    status: "stored",
    name: secretName,
    kind: "secret",
    ref: { source: "store", provider, id: secretName },
    currentPolicy,
  });
}

function promptOptions(
  sessionKey: string,
  send: NonNullable<Parameters<typeof createSecretsTool>[0]["questionPrompt"]>["send"],
  messageChannel = "telegram",
) {
  return {
    config: { gateway: { publicOrigin: "https://ops.example.test" } },
    sessionKey,
    questionPrompt: { send, messageChannel },
  };
}

beforeEach(() => {
  onTestFinished(() => {
    questionResolverSpy?.mockRestore();
    storeTransportSpy?.mockRestore();
    questionResolverSpy = undefined;
    storeTransportSpy = undefined;
  });
});

describe("secrets request normalization", () => {
  it("builds one store-bound secret question and clamps its timeout", () => {
    for (const [timeoutSeconds, clamped] of [
      [5, 30],
      [9_999, 3_600],
    ]) {
      expect(normalizeSecretsRequestParams({ ...proposedRequest, timeoutSeconds })).toEqual({
        name: secretName,
        timeoutSeconds: clamped,
        questions: [secretQuestion],
      });
    }
    const schema = createSecretsTool({}).parameters;
    expect(
      Value.Check(schema, {
        action: "set",
        name: secretName,
        value: "test-secret-value-123",
      }),
    ).toBe(false);
  });

  it.each([
    ["lowercase names", { name: "bad_name" }, "uppercase"],
    ["readable environment-value requests", { kind: "env" }, 'kind must be "secret"'],
    ["duplicate allowed hosts", { allowedHosts: ["a.test", "a.test"] }, "unique"],
    ["oversized reasons", { reason: "r".repeat(201) }, "at most 200"],
    ["fractional timeouts", { timeoutSeconds: 1.5 }, "integer"],
  ])("rejects %s before contacting the gateway", (_label, overrides, message) => {
    expect(() => normalizeSecretsRequestParams({ ...secretRequest, ...overrides })).toThrow(
      message,
    );
  });
});

describe("secrets tool", () => {
  it("returns a clear local store blocker without publishing a credential prompt", async () => {
    const previousMode = isEmbeddedMode();
    const events: string[] = [];
    const broker = new EmbeddedQuestionBroker(createTestGatewayScheduler(), (event) =>
      events.push(event.event),
    );
    setEmbeddedMode(true);
    setEmbeddedQuestionBroker(broker);
    try {
      await expect(
        createSecretsTool({ sessionKey: "agent:main:main" }).execute("local-secret", {
          action: "request",
          name: secretName,
        }),
      ).rejects.toThrow(
        "Secret store requests need a running Gateway; ask the operator to run `openclaw secrets store` or use the Control UI.",
      );
      expect(events).toEqual([]);
      expect(broker.list().questions).toEqual([]);
    } finally {
      clearEmbeddedQuestionBroker(broker);
      broker.stop();
      setEmbeddedMode(previousMode);
    }
  });

  it("returns a valid shared-default store ref without claiming chat text", async () => {
    const config: OpenClawConfig = {
      secrets: {
        defaults: { store: "teamstore" },
        providers: { teamstore: { source: "env" } },
      },
    };
    const { gateway, answer, waiting } = waitingStoredRequestGateway();
    const tool = secretTool(gateway, {
      config,
      agentId: "main",
      sessionKey: "agent:main:secrets",
      runId: "run-secrets",
    });
    const pending = tool.execute("call-secret", proposedRequest);
    settleOnCleanup(pending, () => answer.resolve({ status: "cancelled" }));
    await waiting;

    await expect(
      claimPendingAgentQuestionAnswer({
        sessionKey: "agent:main:secrets",
        text: "test-secret-value-123",
      }),
    ).resolves.toBe(false);
    answer.resolve(storedAnswer);
    const result = await pending;

    const ref = SecretRefSchema.parse(asNullableRecord(result.details)?.ref);
    expect(ref).toMatchObject({ source: "store", id: secretName });
    expect(isBuiltInDefaultSecretProviderRef(config, ref)).toBe(true);
    expectStoredDetails(result.details, editedPolicy, "teamstore");
    for (const guidance of [
      "Use the returned ref",
      "this entry's current host list; the human may edit it",
      "Not Gateway config or an approval receipt; may change later",
      "Report current hosts, not proposed hosts",
      "Do not infer why they differ or prescribe Gateway config changes from the difference",
    ]) {
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(guidance) });
    }
    expect(JSON.stringify(result)).not.toMatch(
      /test-secret-value-123|api\.example\.test|UNRELATED_ENV|private-env-value/,
    );
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(storedMethods);
    expect(gateway.mock).toHaveBeenLastCalledWith("secrets.store.list", {}, {}, undefined);
    expect(gateway.mock).toHaveBeenCalledWith(
      "question.request",
      {},
      expect.objectContaining({
        id: expect.stringMatching(/^ask_[a-f0-9]{32}$/),
        agentId: "main",
        sessionKey: "agent:main:secrets",
        runId: "run-secrets",
        timeoutMs: 900_000,
        questions: [expect.objectContaining(secretQuestion)],
      }),
      // Store-bound minting is admin-gated server-side; the tool must declare
      // the scope explicitly instead of the questions-scope default.
      { scopes: ["operator.admin"], requireAgentRuntimeIdentity: true },
    );
  });

  it.each(["pending", "cancelled"] as const)(
    "returns no_answer when a credential request is %s",
    async (status) => {
      const gateway = requestGateway({
        "question.waitAnswer": async () => ({ status }),
        "question.resolve": async () => ({ status }),
      });

      const result = await secretTool(gateway, { sessionKey: `agent:main:${status}` }).execute(
        `call-${status}`,
        secretRequest,
      );

      expect(result.details).toEqual({ status: "no_answer" });
      expect(methodCalls(gateway, "secrets.store.list")).toHaveLength(0);
      if (status === "pending") {
        expectCancellation(gateway, "wait-timeout");
      }
    },
  );

  it.each([
    { boundary: "wait timeout", marker: "stored", abort: false },
    { boundary: "delivery failure", marker: "stored", abort: false },
    { boundary: "delivery failure", marker: "unexpected", abort: false },
    { boundary: "delivery failure", marker: "stored", abort: true },
  ])(
    "consumes canonical answers after $boundary (marker=$marker, abort=$abort)",
    async ({ boundary, marker, abort }) => {
      const terminal = Object.assign(new Error("question is already answered"), {
        name: "GatewayClientRequestError",
        details: { reason: "QUESTION_ALREADY_TERMINAL" },
      });
      const sessionKey = "agent:main:late-answer";
      const toolCallId = "call-late-answer";
      const reservation =
        boundary === "delivery failure" ? reservePrompt(toolCallId, sessionKey) : undefined;
      const firstWait = createDeferred<unknown>();
      const controller = new AbortController();
      let waitCalls = 0;
      const gateway = requestGateway({
        "question.resolve": async () => {
          if (abort) {
            await Promise.resolve();
            controller.abort(new Error("run stopped"));
          }
          throw terminal;
        },
        "secrets.store.list": async () => ({ entries: [secretEntry] }),
        "question.waitAnswer": async () => {
          if (++waitCalls === 1) {
            return boundary === "wait timeout" ? { status: "pending" } : await firstWait.promise;
          }
          return { status: "answered", answers: { answers: { secret_value: [marker] } } };
        },
      });
      const result = outcome(
        secretTool(gateway, { sessionKey }).execute(toolCallId, secretRequest, controller.signal),
      );
      try {
        if (reservation) {
          await vi.waitFor(() => expect(waitCalls).toBe(1));
          settleAskUserPromptDelivery(reservation.questionId, new Error("transport failed"));
        }
        const error = abort
          ? "run stopped"
          : marker !== "stored"
            ? "credential request returned an unexpected answer marker"
            : undefined;
        await expect(result).resolves.toMatchObject(
          error
            ? { error: new Error(error) }
            : {
                result: {
                  details: { status: "stored", name: secretName, currentPolicy: editedPolicy },
                },
              },
        );
        expect(methodCalls(gateway, "secrets.store.list")).toHaveLength(
          !abort && marker === "stored" ? 1 : 0,
        );
        expect(methodCalls(gateway, "question.resolve")).toHaveLength(1);
      } finally {
        firstWait.resolve({ status: "cancelled" });
        await result;
      }
    },
  );

  const longHost = `${"a".repeat(62)}.${"b".repeat(62)}.${"c".repeat(62)}.${"d".repeat(59)}.test`;
  const oversizedHosts = [longHost, `e${longHost.slice(1)}`];
  it.each([
    [
      "513-character array",
      { ...secretEntry, allowedHosts: oversizedHosts },
      { status: "omitted", allowedHostCount: 2 },
    ],
    ["absent host policy", { ...storeMetadata, kind: "secret" }, { status: "unavailable" }],
    ["missing entry", unrelatedEnv, { status: "missing" }],
    [
      "kind changed to env",
      { ...unrelatedEnv, name: storeMetadata.name },
      { status: "kind_changed" },
    ],
    ["read rejection", new Error("private-env-value"), { status: "unavailable" }],
    [
      "invalid secret fields",
      { ...secretEntry, value: "private-env-value" },
      { status: "unavailable" },
    ],
  ])("preserves stored truth with %s metadata", async (_label, metadata, currentPolicy) => {
    const gateway = storedRequestGateway(async () => {
      if (metadata instanceof Error) {
        throw metadata;
      }
      return { entries: [metadata] };
    });
    const result = await secretTool(gateway).execute("policy-result", {
      action: "request",
      name: secretName,
      allowedHosts: ["proposed.example.test"],
    });
    expectStoredDetails(result.details, currentPolicy);
    expect(gateway.mock.mock.calls.map(([method]) => method)).toEqual(storedMethods);
    const text = result.content[0];
    assert(text?.type === "text", "expected text result");
    expect(text.text.length).toBeLessThan(1800);
    expect(text.text).not.toMatch(/private-env-value|UNRELATED_ENV|proposed\.example\.test/);
    expect(text.text).not.toContain(longHost.slice(0, 62));
    expect(text.text).not.toContain("allowedHosts");
  });

  it.each(["resolve", "reject"] as const)(
    "keeps abort authoritative when metadata %ss",
    async (settlement) => {
      const metadata = createDeferred<unknown>();
      const controller = new AbortController();
      const gateway = storedRequestGateway(() => metadata.promise);
      const result = outcome(
        secretTool(gateway).execute("abort-policy", secretRequest, controller.signal),
      );
      try {
        await vi.waitFor(() =>
          expect(methodCalls(gateway, "secrets.store.list").length).toBeGreaterThan(0),
        );
        expect(gateway.mock).toHaveBeenLastCalledWith(
          "secrets.store.list",
          {},
          {},
          { signal: controller.signal },
        );
        controller.abort(new Error("run stopped during metadata"));
        if (settlement === "reject") {
          metadata.reject(new Error("private-env-value"));
        } else {
          metadata.resolve({ entries: [secretEntry] });
        }
        await expect(result).resolves.toEqual({ error: new Error("run stopped during metadata") });
      } finally {
        controller.abort();
        metadata.resolve({ entries: [secretEntry] });
        await result;
      }
    },
  );

  it("cancels a registered credential request when its agent run aborts", async () => {
    const controller = new AbortController();
    const gateway = requestGateway({
      "question.resolve": async () => ({ status: "cancelled" }),
      "question.waitAnswer": async (_method, _options, _params, extra) =>
        new Promise((_resolve, reject) => {
          extra?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const pending = secretTool(gateway, { sessionKey: "agent:main:secret-abort" }).execute(
      "call-secret-abort",
      secretRequest,
      controller.signal,
    );
    settleOnCleanup(pending, () => controller.abort());
    await vi.waitFor(() =>
      expect(methodCalls(gateway, "question.waitAnswer").length).toBeGreaterThan(0),
    );

    controller.abort(new Error("stop"));

    await expect(pending).rejects.toThrow("aborted");
    expectCancellation(gateway, "run-abort");
  });

  it.each(["lost reply", "aborted reply", "answered reply", "refused ID"])(
    "preserves question truth and the original error after %s",
    async (scenario) => {
      const answered = scenario === "answered reply";
      const refused = scenario === "refused ID";
      const abort = scenario === "aborted reply" || refused;
      const error = answered
        ? new GatewayClientRequestError({ code: "UNAVAILABLE", message: "registration failed" })
        : new Error("registration failed");
      if (refused) {
        Object.assign(error, {
          name: "GatewayClientRequestError",
          details: { reason: "QUESTION_ID_IN_USE" },
        });
      }
      const scheduler = createTestGatewayScheduler();
      const manager = new QuestionManager(scheduler);
      const controller = new AbortController();
      const sessionKey = "agent:main:secret-registration";
      const reservation = refused ? reservePrompt("call-registration", sessionKey) : undefined;
      if (refused && !reservation) {
        throw new Error("expected prompt reservation");
      }
      const unrelated = structuredClone(
        manager.request({
          id: reservation?.questionId ?? "unrelated-question",
          questions,
          sessionKey: "agent:main:other-requester",
          timeoutMs: 60_000,
        }),
      );
      const transitions: string[] = [];
      const gateway = questionManagerGateway(manager, (request) => {
        if (refused) {
          controller.abort(new Error("run stopped"));
          throw error;
        }
        const record = manager.request({
          ...request,
          onResolved: (event) => transitions.push(event.status),
        });
        if (answered) {
          manager.resolve(record.id, storedAnswer.answers, "operator:human");
        }
        if (abort) {
          controller.abort(new Error("run stopped"));
        }
        throw error;
      });

      try {
        await expect(
          secretTool(gateway, { sessionKey }).execute(
            "call-registration",
            secretRequest,
            controller.signal,
          ),
        ).rejects.toBe(error);

        if (!refused) {
          expect(manager.get(requestedQuestionId(gateway.mock))).toMatchObject(
            answered
              ? { status: "answered", answers: storedAnswer.answers, resolvedBy: "operator:human" }
              : { status: "cancelled" },
          );
        }
        expect(transitions).toEqual(refused ? [] : [answered ? "answered" : "cancelled"]);
        expect(manager.get(unrelated.id)).toEqual(unrelated);
        expect(methodCalls(gateway, "question.resolve")).toHaveLength(refused ? 0 : 1);
        expect(methodCalls(gateway, "question.request")).toHaveLength(1);
        expect(methodCalls(gateway, "secrets.store.list")).toHaveLength(0);
        expect(reservePrompt("call-after-registration", sessionKey)).toBeDefined();
      } finally {
        manager.close();
        await manager.drain();
        await scheduler.stop();
      }
    },
  );

  it.each([
    ["telegram", true],
    ["control-ui-only", false],
  ] as const)(
    "publishes an unreserved credential link only on deliverable %s",
    async (channel, deliver) => {
      const sent: { text?: string; channelData?: unknown }[] = [];
      const { gateway, answer, waiting } = waitingStoredRequestGateway(deliver);
      const options = promptOptions(
        "agent:main:secret-direct-dispatch",
        (payload) => {
          sent.push(payload);
        },
        channel,
      );
      const pending = secretTool(gateway, options).execute("call-secret-direct", secretRequest);
      settleOnCleanup(pending, () => answer.resolve({ status: "cancelled" }));
      await waiting;
      if (deliver) {
        await vi.waitFor(() => expect(sent).toHaveLength(1));
      }
      answer.resolve(deliver ? storedAnswer : { status: "expired" });
      await expect(pending).resolves.toMatchObject({
        details: { status: deliver ? "stored" : "no_answer" },
      });
      if (deliver) {
        expect(sent[0]?.text).toContain("https://ops.example.test/ask/");
        expect(sent[0]?.text).toContain(secretName);
      } else {
        expect(sent).toEqual([]);
      }
    },
  );

  it.each([
    ["missing origin", {}, undefined],
    [
      "disabled Control UI",
      { gateway: { publicOrigin: "https://ops.example.test", controlUi: { enabled: false } } },
      undefined,
    ],
    ["transport failure", {}, new Error("private transport diagnostic")],
  ] as const)(
    "returns safe model-facing guidance after cancelling a request with %s",
    async (_name, config, deliveryError) => {
      const scheduler = createTestGatewayScheduler();
      const manager = new QuestionManager(scheduler);
      const gateway = questionManagerGateway(manager, (request) => manager.request(request));
      const sent: { text?: string }[] = [];
      const tool = secretTool(gateway, {
        ...promptOptions("agent:main:secret-no-route", (payload) => {
          sent.push(payload);
          if (deliveryError) {
            throw deliveryError;
          }
        }),
        config,
      });

      try {
        const [definition] = toToolDefinitions([tool]);
        assert.ok(definition);
        const result = await wrapToolDefinition(definition).execute(
          "call-secret-no-route",
          secretRequest,
        );

        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain("Credential request unavailable here");
        expect(sent[0]?.text).not.toMatch(/https?:/);
        expect(manager.get(requestedQuestionId(gateway.mock))).toMatchObject({
          status: "cancelled",
          resolvedBy: "prompt-delivery-failed",
        });
        expect(result.details).toEqual({
          status: "error",
          tool: "secrets",
          error: deliveryError ? "credential-request prompt delivery failed" : sent[0]?.text,
        });
        expect(JSON.stringify(result)).not.toContain("private transport diagnostic");
      } finally {
        manager.close();
        await manager.drain();
        await scheduler.stop();
      }
    },
  );

  it("ends credential publication before post-answer metadata finishes", async () => {
    let capturedSignal: AbortSignal | undefined;
    const answer = createDeferred<unknown>();
    const promptReleased = createDeferred();
    const metadataStarted = createDeferred();
    const metadata = createDeferred<{ entries: (typeof secretEntry)[] }>();
    const gateway = requestGateway({
      "question.waitAnswer": async () => answer.promise,
      "secrets.store.list": async () => {
        metadataStarted.resolve();
        return metadata.promise;
      },
    });
    const pending = secretTool(
      gateway,
      promptOptions("agent:main:secret-direct-dispatch-abort", (_payload, options) => {
        capturedSignal = options?.signal;
        return promptReleased.promise;
      }),
    ).execute("call-secret-direct-abort", secretRequest);
    settleOnCleanup(pending, () => {
      answer.resolve({ status: "cancelled" });
      metadata.resolve({ entries: [secretEntry] });
      promptReleased.resolve();
    });

    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);
    answer.resolve(storedAnswer);
    try {
      await metadataStarted.promise;
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      metadata.resolve({ entries: [secretEntry] });
      await expect(pending).resolves.toMatchObject({ details: { status: "stored" } });
    }
  });

  it("lists store metadata and environment previews", async () => {
    const entries = [
      {
        ...secretEntry,
        allowedHosts: ["api.example.test"],
        updatedBy: "operator:alice",
      },
      {
        ...unrelatedEnv,
        name: "SERVICE_MODE",
        value: "preview-value",
      },
    ];
    const gateway = gatewayStub(async () => ({ entries }));

    const result = await secretTool(gateway).execute("call-list", {
      action: "list",
    });

    expect(result.details).toEqual({ entries });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("SERVICE_API_KEY | secret | hosts: api.example.test"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("value: preview-value"),
    });
    expect(gateway.mock).toHaveBeenCalledWith("secrets.store.list", {}, {}, undefined);
  });

  it("requires verified agent runtime identity when deleting a store entry", async () => {
    const gateway = gatewayStub(async () => ({ ok: true, reloaded: false }));

    const result = await secretTool(gateway).execute("call-delete", {
      action: "delete",
      name: secretName,
    });

    expect(result.details).toEqual({ ok: true, reloaded: false });
    expect(gateway.mock).toHaveBeenCalledWith(
      "secrets.store.delete",
      {},
      { name: secretName },
      { requireAgentRuntimeIdentity: true },
    );
  });
});
