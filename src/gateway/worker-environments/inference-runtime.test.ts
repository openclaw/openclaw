import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { validateWorkerInferenceTerminalOutcome } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindAgentToolExecutionLocation } from "../../agents/agent-tool-metadata.js";
import * as authProfileStore from "../../agents/auth-profiles/store-runtime.js";
import * as authProfileUsage from "../../agents/auth-profiles/usage.js";
import * as modelAuth from "../../agents/model-auth.js";
import * as providerStreamRuntime from "../../agents/provider-stream.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import * as simpleCompletionRuntime from "../../agents/simple-completion-runtime.js";
import { createToolSurfacePresentationForTest } from "../../agents/tool-surface-plan.test-support.js";
import { makeZeroUsageSnapshot } from "../../agents/usage.js";
import { onTrustedInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  StreamFn,
  ToolCall,
} from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { ProviderWrapStreamFnContext } from "../../plugins/provider-transport.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { parseApiErrorInfo } from "../../shared/assistant-error-format.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
} from "../../worker/transcript-message.js";
import * as fixture from "./inference-runtime.test-support.js";
import { createWorkerToolCallStream } from "./inference-tool-call-stream.js";
import * as workerTurnOwners from "./placement-turn-claim-events.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";

const { ALIAS, AUTH_MARKER, BASE_URL, ENDPOINT, MODEL, PROFILE, PROVIDER } = fixture;
const { SESSION_ID, TOOL_CALL, WORKSPACE, config, finalMessage, logicalModel } = fixture;
const { params, providerStream, request, sessionEntry, setup, usage } = fixture;
type Execution = fixture.Execution;
type Runtime = ReturnType<typeof setup>;
const execute = (runtime: Runtime, input = request(), emit: Execution["emit"] = vi.fn()) =>
  runtime.executor(params(input, emit));
const expectDone = (runtime: Runtime, input = request()) =>
  expect(execute(runtime, input)).resolves.toMatchObject({ type: "done" });
function expectCalls(count: number, ...mocks: Array<{ mock: { calls: unknown[][] } }>) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}
function eventStream(...events: AssistantMessageEvent[]) {
  const stream = createAssistantMessageEventStream();
  for (const event of events) {
    stream.push(event);
  }
  return stream;
}
function providerRegistry(
  pluginId: string,
  label: string,
  hooks: Omit<
    ReturnType<typeof createEmptyPluginRegistry>["providers"][number]["provider"],
    "id" | "label" | "auth"
  >,
) {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId,
    source: "test",
    provider: { id: PROVIDER, label, auth: [], ...hooks },
  });
  return registry;
}
type Diagnostic = Parameters<Parameters<typeof onTrustedInternalDiagnosticEvent>[0]>[0];
function captureDiagnostics(matches: (event: Diagnostic) => boolean) {
  const events: Diagnostic[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
    if (matches(event)) {
      events.push(event);
    }
  });
  return { events, unsubscribe };
}
const captureUsage = () =>
  captureDiagnostics((event) => event.type === "model.usage" && event.sessionId === SESSION_ID);
function toolStream({
  partial = finalMessage(),
  terminal = partial,
  deltas = ["{}"],
  start = true,
  ended = false,
  afterEnd = [],
  reason = "toolUse",
  contentIndex = 1,
  toolCall = TOOL_CALL,
}: {
  partial?: AssistantMessage;
  terminal?: AssistantMessage;
  deltas?: readonly string[];
  start?: boolean;
  ended?: boolean;
  afterEnd?: string[];
  reason?: Extract<AssistantMessageEvent, { type: "done" }>["reason"];
  contentIndex?: number;
  toolCall?: ToolCall;
} = {}) {
  const stream = createAssistantMessageEventStream();
  if (start) {
    stream.push({ type: "toolcall_start", contentIndex, partial });
  }
  const delta = (value: string) =>
    stream.push({ type: "toolcall_delta", contentIndex, delta: value, partial });
  deltas.forEach(delta);
  if (ended) {
    stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
  }
  afterEnd.forEach(delta);
  stream.push({ type: "done", reason, message: terminal });
  return stream;
}
function messageWithTool(tool: ToolCall) {
  const message = finalMessage();
  message.content[message.content.length - 1] = tool;
  return message;
}
function mismatchedTools(ended: boolean, omitted = false, unidentified = false) {
  const partial = messageWithTool(unidentified ? { ...TOOL_CALL, id: "", name: "" } : TOOL_CALL);
  const terminal = messageWithTool({ ...TOOL_CALL, id: "call-2" });
  if (omitted) {
    terminal.content = terminal.content.slice(0, 1);
  }
  return {
    partial,
    terminal,
    start: !unidentified,
    ended,
    reason: omitted ? ("stop" as const) : ("toolUse" as const),
  };
}

const MODEL_ERROR = {
  type: "error",
  reason: "model-not-approved",
  message: "Model is not approved for this agent.",
};

describe("worker inference provider runtime", () => {
  it("constructs only the embedded provider stream when preparing a worker turn", async () => {
    const prepareModel = simpleCompletionRuntime.prepareSimpleCompletionModel;
    const registerProviderStream = providerStreamRuntime.registerProviderStreamForModel;
    const stream = vi.fn<StreamFn>(() => providerStream());
    const createStreamFn = vi.fn(() => stream);
    const wrapSimpleCompletionStreamFn = vi.fn(
      ({ streamFn }: ProviderWrapStreamFnContext) => streamFn,
    );
    const pluginRegistry = providerRegistry("worker-provider", "Worker provider", {
      createStreamFn,
      wrapSimpleCompletionStreamFn,
    });
    const runtime = setup({ sessionId: SESSION_ID, updatedAt: 1 }, { pluginRegistry });
    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    vi.spyOn(authProfileStore, "ensureAuthProfileStoreAsync").mockResolvedValue({
      version: 1,
      profiles: {
        "openai:worker": { type: "api_key", provider: PROVIDER, key: AUTH_MARKER },
      },
    });
    vi.spyOn(authProfileUsage, "reconcileAuthProfileQuotaBlocks").mockResolvedValue(undefined);
    vi.spyOn(modelAuth, "getApiKeyForModelCore").mockResolvedValue({
      apiKey: AUTH_MARKER,
      mode: "api-key",
      source: "worker provider fixture",
    });
    runtime.prepareModel.mockImplementation((modelParams, assertCurrent) =>
      prepareModel(
        {
          ...modelParams,
          modelResolver: async (_provider, _modelId, _agentDir, cfg) => ({
            model: {
              ...logicalModel,
              api: cfg?.models?.providers?.openai?.api ?? logicalModel.api,
              baseUrl: cfg?.models?.providers?.openai?.baseUrl ?? logicalModel.baseUrl,
            },
            authStorage,
            modelRegistry,
          }),
        },
        assertCurrent,
      ),
    );
    vi.mocked(providerStreamRuntime.registerProviderStreamForModel).mockImplementation(
      registerProviderStream,
    );

    await expect(execute(runtime)).resolves.toMatchObject({
      type: "done",
      message: { provider: PROVIDER, model: MODEL },
    });
    expectCalls(1, createStreamFn, stream, runtime.releaseRuntime);
    expect(wrapSimpleCompletionStreamFn).not.toHaveBeenCalled();
    expect(stream.mock.calls[0]?.[2]).toMatchObject({ apiKey: AUTH_MARKER });
  });

  it.each([
    [
      "boundary rotation",
      [0, 0, 2],
      undefined,
      [`${SESSION_ID}:0`, `${SESSION_ID}:0`, `${SESSION_ID}:2`],
    ],
    ["explicit key", [3], " gateway-explicit-cache ", ["gateway-explicit-cache"]],
  ] as const)(
    "uses the Gateway cache owner for %s",
    async (_name, boundaries, explicitKey, keys) => {
      const runtime = setup();
      for (const boundaryCount of boundaries) {
        runtime.readPromptCacheContext.mockReturnValue({
          boundaryCount,
          ...(explicitKey ? { promptCacheKey: explicitKey } : {}),
        });
        const inferenceRequest = request();
        if (!explicitKey) {
          Object.assign(inferenceRequest.options, { promptCacheKey: "worker-chosen-key" });
        }
        await expectDone(runtime, inferenceRequest);
      }
      expect(runtime.stream.mock.calls.map((call) => call[2]?.promptCacheKey)).toEqual(keys);
      expect(runtime.stream.mock.calls.map((call) => call[2]?.sessionId)).toEqual(
        boundaries.map(() => SESSION_ID),
      );
      if (explicitKey) {
        runtime.readPromptCacheContext.mockReturnValue(undefined);
        await expect(execute(runtime)).resolves.toMatchObject({
          type: "error",
          reason: "session-not-attached",
        });
        expect(runtime.stream).toHaveBeenCalledOnce();
      }
    },
  );

  it("retains runtime context under the approved replay policy", async () => {
    const pluginRegistry = providerRegistry("worker-replay-policy", "Worker replay policy", {
      buildReplayPolicy: ({ modelId, modelApi }) => ({
        appendOnlyRuntimeContext: modelId === MODEL && modelApi === logicalModel.api,
      }),
    });
    const runtime = setup(sessionEntry, { pluginRegistry, config: structuredClone(config) });
    const inferenceRequest = request(ALIAS);
    inferenceRequest.context.messages = [
      { role: "user", content: "Earlier facts", timestamp: 1, runtimeContext: {} },
      { role: "user", content: "Current question", timestamp: 2 },
      { role: "user", content: "Current facts", timestamp: 3, runtimeContext: {} },
    ];
    const original = structuredClone(inferenceRequest);
    expect((await execute(runtime, inferenceRequest)).type).toBe("done");
    const messages = runtime.stream.mock.calls[0]?.[1].messages;
    expect(messages).toMatchObject([
      { content: "Earlier facts", runtimeContext: { retained: true } },
      { content: "Current question" },
      { content: "Current facts", runtimeContext: { retained: true } },
    ]);
    expect(messages?.[1]).not.toHaveProperty("runtimeContext");
    expect(inferenceRequest).toEqual(original);
  });

  it("prepares an approved model available only from the bundled static catalog", async () => {
    const runtime = setup(sessionEntry, { catalogOnlyModel: true });

    await expect(execute(runtime, request(MODEL))).resolves.toMatchObject({
      type: "done",
      message: { provider: PROVIDER, model: MODEL },
    });
    expectCalls(1, runtime.stream, runtime.releaseRuntime);
  });

  it("returns bounded, redacted model preparation guidance", async () => {
    const runtime = setup();
    const secret = `worker-preparation-secret-${"a".repeat(48)}`;
    runtime.prepareModel.mockResolvedValueOnce({
      error: `Auth lookup failed for provider "anthropic": configure the selected auth profile. Authorization: Bearer ${secret}. ${"diagnostic ".repeat(40)}`,
    });

    const failure = await runtime
      .executor(params(request(), vi.fn()))
      .catch((error: unknown) => error);
    assert(failure instanceof Error, "expected model preparation to fail");
    const message = failure.message;
    expect(message).toContain("configure the selected auth profile");
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThanOrEqual(256);
    expect(runtime.stream).not.toHaveBeenCalled();
    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    { errorCode: "insufficient_quota", detailed: false },
    { errorCode: "rate_limit_exceeded", detailed: true },
  ])(
    "preserves bounded, redacted streamed provider failure $errorCode",
    async ({ errorCode, detailed }) => {
      const runtime = setup();
      const secret = `stream-secret-${"a".repeat(48)}`;
      runtime.stream.mockImplementation(() =>
        eventStream({
          type: "error",
          reason: "error",
          error: {
            ...finalMessage(),
            stopReason: "error",
            errorCode,
            ...(detailed
              ? {
                  errorMessage: `429: Authorization: Bearer ${secret} ${'diagnostic " \\ '.repeat(80)}`,
                  errorType: "rate_limit_error",
                }
              : {}),
          },
        }),
      );

      const outcome = await execute(runtime);

      expect(outcome).toMatchObject({ type: "error", reason: "provider-error", usage });
      assert(outcome.type === "error", "expected provider failure");
      expect(parseApiErrorInfo(outcome.message)?.code).toBe(errorCode);
      if (detailed) {
        expect(parseApiErrorInfo(outcome.message)).toMatchObject({
          httpCode: "429",
          code: errorCode,
          type: "rate_limit_error",
        });
        expect(outcome.message).not.toContain(secret);
        expect(outcome.message.length).toBeLessThanOrEqual(256);
      }
      expect(validateWorkerInferenceTerminalOutcome(outcome)).toBe(true);
    },
  );

  it.each([
    { name: "short body", status: 503, code: "upstream_unavailable", detail: "Unavailable" },
    { name: "long body", status: 429, code: "insufficient_quota", detail: "x".repeat(520) },
    { name: "bigint diagnostic", status: 429, code: "insufficient_quota", detail: 1n },
  ])("preserves a thrown provider HTTP failure ($name)", async ({ status, code, detail }) => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      throw Object.assign(new Error("Request rejected"), {
        status,
        body: { error: { detail, code, message: "Provider request rejected" } },
      });
    });

    const outcome = await execute(runtime);

    assert(outcome.type === "error", "expected provider failure");
    expect(outcome).toMatchObject({ type: "error", reason: "provider-error" });
    expect(parseApiErrorInfo(outcome.message)).toMatchObject({
      httpCode: String(status),
      code,
    });
    expect(outcome.message).toContain("Provider request rejected");
    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "TPM floor beyond bounded text",
      "Provider diagnostic ".repeat(80),
      { code: "rate_limit_exceeded" },
      { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "1m2.5s" },
      62_500,
    ],
    [
      "unrepresentable JSON retry floor",
      "rate limited",
      { error: { code: "rate_limit_exceeded", message: "rate limited" } },
      { "retry-after": "9".repeat(30) },
      null,
    ],
  ] as const)("preserves %s", async (_name, message, error, headers, retryAfterMs) => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      throw Object.assign(new Error(message), {
        status: 429,
        ...error,
        headers: new Headers(headers),
      });
    });
    const outcome = await execute(runtime);
    expect(outcome).toMatchObject({ type: "error", reason: "provider-error", retryAfterMs });
    expect(validateWorkerInferenceTerminalOutcome(outcome)).toBe(true);
  });

  it("keeps provider construction and execution on the leased generation", async () => {
    const generationA = createEmptyPluginRegistry();
    const generationB = createEmptyPluginRegistry();
    const observed: string[] = [];
    const runtime = setup(sessionEntry, {
      pluginRegistry: generationA,
      afterModelPreparation: () =>
        setActivePluginRegistry(generationB, "worker-generation-b", "default", WORKSPACE),
      observeStage: (stage, registry) =>
        observed.push(
          `${stage}:${registry === generationA ? "A" : registry === generationB ? "B" : "none"}`,
        ),
    });

    try {
      await expectDone(runtime);
    } finally {
      resetPluginRuntimeStateForTest();
    }

    expect(observed).toEqual(["factory:A", "policy:A", "wrapper:A", "execution:A"]);
    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    ["user", "api-key", "api-key", "openai-responses", "https://api.openai.com/v1"],
    [
      "auto",
      "subscription",
      "oauth",
      "openai-chatgpt-responses",
      "https://chatgpt.com/backend-api/codex",
    ],
  ] as const)(
    "pins the %s profile to its %s route",
    async (source, routeRequirement, auth, api, baseUrl) => {
      const runtime = setup(
        source === "auto"
          ? {
              ...sessionEntry,
              authProfileOverrideSource: "auto",
              authProfileOverrideCompactionCount: 1,
            }
          : sessionEntry,
      );
      runtime.resolveAuthSelection.mockResolvedValue({
        profileId: PROFILE,
        source,
        routeRequirement,
      });

      await expectDone(runtime);
      expect(runtime.prepareModel.mock.calls[0]?.[0].cfg?.models?.providers?.openai).toMatchObject({
        auth,
        api,
        baseUrl,
      });
      expect(runtime.prepareModel).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: PROFILE,
          preferredProfile: PROFILE,
          bindAuthOwner: true,
        }),
      );
    },
  );

  it("keeps approved alias routing, endpoint, headers, and auth gateway-owned", async () => {
    const runtime = setup();
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    const { events: usageEvents, unsubscribe } = captureUsage();
    const inferenceRequest = request();
    const execution = params(inferenceRequest, (event) => emitted.push(event));
    const outcome = await runtime.executor(execution).finally(unsubscribe);

    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();

    expect(runtime.prepareModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: MODEL,
        profileId: PROFILE,
        bindAuthOwner: true,
        cfg: config,
      }),
    );
    const prepared = runtime.prepareModel.mock.calls[0]?.[0];
    expect(prepared?.signal).toBe(execution.signal);
    const lease = await runtime.acquireRuntimeLease.mock.results[0]?.value;
    expect(prepared).toMatchObject({ agentRuntimeId: "openclaw", workspaceDir: WORKSPACE });
    expect(prepared?.agentDir).toBe(runtime.acquireRuntimeLease.mock.calls[0]?.[0].agentDir);
    expect(prepared?.preparedModelRuntime).toBe(lease.snapshot);
    expect(runtime.resolveStream.mock.calls[0]?.[0].authProfileId).toBe(PROFILE);
    expect(runtime.acquireRuntimeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "runtime-agent",
      }),
    );
    const [streamModel, streamContext, streamOptions] = runtime.stream.mock.calls[0] ?? [];
    expect(streamModel).toMatchObject({ baseUrl: ENDPOINT });
    expect(streamContext?.messages).toEqual(inferenceRequest.context.messages);
    expect(streamOptions).toEqual({
      ...inferenceRequest.options,
      signal: expect.any(AbortSignal),
      sessionId: SESSION_ID,
      promptCacheKey: `${SESSION_ID}:0`,
      apiKey: AUTH_MARKER,
    });
    expect(emitted.map((event) => event.type)).toEqual([
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(emitted).toContainEqual({
      type: "toolcall_start",
      contentIndex: 1,
      id: TOOL_CALL.id,
      toolName: TOOL_CALL.name,
    });
    expect(outcome).toMatchObject({
      type: "done",
      message: {
        api: logicalModel.api,
        provider: PROVIDER,
        model: MODEL,
        usage,
      },
    });
    const outbound = JSON.stringify({ emitted, outcome });
    for (const privateValue of [BASE_URL, ENDPOINT, AUTH_MARKER, "x-gateway-route"]) {
      expect(outbound).not.toContain(privateValue);
    }
    expect(usageEvents).toEqual([
      expect.objectContaining({
        channel: "worker",
        durationMs: 25,
        provider: PROVIDER,
        model: MODEL,
      }),
    ]);
  });

  it.each(["text", "unsupported"])(
    "projects %s terminal content onto the closed worker schema",
    async (type) => {
      const runtime = setup();
      const message = finalMessage();
      const ciphertext = `cipher-${"x".repeat(60 * 1024)}-€`;
      message.providerReplay = {
        v: 1,
        type: "openai-responses-compaction",
        id: "cmp_worker_terminal",
        data: ciphertext,
        replayIndex: 1,
        provider: "openai",
        api: "openai-responses",
        model: MODEL,
        baseUrlHash: "ozhevd1smnk8s",
        sessionHash: "171dzdv17gum5g",
        authProfileHash: "oe8bkr3r8947",
      };
      Object.assign(message.content[0]!, { type, providerScratch: "text-state" });
      Object.assign(message.content[1]!, { partialJson: "{}", streamIndex: 0 });
      Object.assign(message.usage, { providerScratch: { requestId: "private" } });
      Object.assign(message.providerReplay, { providerScratch: "private" });
      runtime.stream.mockImplementation(() => providerStream(message));

      const outcome = await execute(runtime);

      expect(validateWorkerInferenceTerminalOutcome(outcome)).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain("providerScratch");
      expect(JSON.stringify(outcome)).not.toContain("partialJson");
      expect(JSON.stringify(outcome)).not.toContain("streamIndex");
      if (type === "unsupported") {
        expect(outcome).toMatchObject({
          type: "error",
          reason: "provider-error",
          message: '{"message":"Unsupported assistant terminal content"}',
        });
        return;
      }
      expect(outcome).toMatchObject({
        type: "done",
        message: {
          providerReplay: {
            type: "openai-responses-compaction",
            data: ciphertext,
            replayIndex: 1,
            sessionHash: "171dzdv17gum5g",
            authProfileHash: "oe8bkr3r8947",
          },
        },
      });
      assert(outcome.type === "done", "expected successful worker inference");
      expect(isWorkerTranscriptMessageFrameSafe(outcome.message)).toBe(true);
    },
  );

  it("canonicalizes fresh reasoning before continuation without rewriting approved history", async () => {
    const runtime = setup();
    const signature =
      '{"type":"reasoning","id":"rs_fresh","encrypted_content":"gAAAA-synthetic==","summary":[{"type":"summary_text","text":"fresh summary"}]}';
    const canonical =
      '{"id":"rs_fresh","type":"reasoning","summary":[],"encrypted_content":"gAAAA-synthetic=="}';
    const message = finalMessage();
    const toolCall = { ...TOOL_CALL, arguments: { token: "synthetic-tool-input" } };
    message.content = [
      { type: "thinking", thinking: "fresh summary", thinkingSignature: signature },
      { type: "text", text: "Calling lookup" },
      toolCall,
    ];
    const original = structuredClone(message);
    runtime.stream.mockImplementation(() =>
      toolStream({
        partial: message,
        contentIndex: 2,
        toolCall,
        ended: true,
        deltas: [JSON.stringify(toolCall.arguments)],
      }),
    );

    const outcome = await execute(runtime);

    assert(outcome.type === "done", "expected successful worker inference");
    expect(outcome.message.content).toEqual([
      { type: "thinking", thinking: "fresh summary", thinkingSignature: canonical },
      { type: "text", text: "Calling lookup" },
      toolCall,
    ]);
    expect(message).toEqual(original);

    const continuation = request();
    continuation.context.messages.push(
      {
        ...outcome.message,
        content: [{ type: "thinking", thinking: "approved history", thinkingSignature: signature }],
      },
      outcome.message,
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "found" }],
        isError: false,
        timestamp: 30,
      },
    );
    const approvedHistory = structuredClone(continuation.context.messages);
    await runtime.executor(params(continuation, vi.fn()));
    expect(runtime.stream.mock.calls[1]?.[1].messages).toEqual(approvedHistory);
    expect(continuation.context.messages).toEqual(approvedHistory);
  });

  it("returns a typed error when authoritative replay cannot be persisted", async () => {
    const runtime = setup();
    const message = finalMessage();
    message.providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1),
      provider: "openai",
      api: "openai-responses",
      model: MODEL,
    };
    runtime.stream.mockImplementation(() => providerStream(message));
    const { events: payloadEvents, unsubscribe } = captureDiagnostics(
      (event) => event.type === "payload.large" && event.surface === "worker.provider-replay",
    );

    const outcome = await execute(runtime).finally(unsubscribe);

    expect(outcome).toMatchObject({
      type: "error",
      reason: "provider-error",
      message: WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
      usage: message.usage,
    });
    expect(payloadEvents).toEqual([
      expect.objectContaining({
        type: "payload.large",
        surface: "worker.provider-replay",
        action: "rejected",
        bytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1,
        limitBytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
        reason: "provider-replay-data-budget",
      }),
    ]);
    expect(JSON.stringify(payloadEvents)).not.toContain(message.providerReplay.data);
  });

  type ToolCase = {
    name: string;
    input: () => Parameters<typeof toolStream>[0];
    done?: boolean;
    deltas?: string[];
    types?: string[];
    noEnd?: boolean;
  };
  it.each([
    {
      name: "incomplete JSON",
      input: () => ({
        partial: messageWithTool({ ...TOOL_CALL, arguments: { query: "alpha" } }),
        deltas: ['{"query":'],
      }),
      deltas: ['{"query":'],
      noEnd: true,
    },
    {
      name: "oversized arguments",
      input: () => ({ deltas: ["x".repeat(1024 * 1024 + 1)] }),
      types: ["toolcall_start"],
    },
    {
      name: "fragmented valid JSON",
      input: () => ({ deltas: [...Array<string>(4096).fill(" "), "{}"] }),
      done: true,
    },
    { name: "changed terminal id", input: () => mismatchedTools(false), noEnd: true },
    { name: "changed id after end", input: () => mismatchedTools(true) },
    { name: "omitted ended tool", input: () => mismatchedTools(true, true) },
    {
      name: "omitted unidentified tool",
      input: () => mismatchedTools(false, true, true),
      noEnd: true,
    },
    { name: "delta after end", input: () => ({ ended: true, afterEnd: [" "] }), deltas: ["{}"] },
  ] satisfies ToolCase[])("validates $name in the tool stream", async (scenario: ToolCase) => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => toolStream(scenario.input()));
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    const outcome = await execute(runtime, request(), (event) => emitted.push(event));
    expect(outcome).toMatchObject(
      scenario.done ? { type: "done" } : { type: "error", reason: "provider-error" },
    );
    if (scenario.deltas) {
      expect(
        emitted.flatMap((event) => (event.type === "toolcall_delta" ? [event.delta] : [])),
      ).toEqual(scenario.deltas);
    }
    if (scenario.types) {
      expect(emitted.map((event) => event.type)).toEqual(scenario.types);
    }
    if (scenario.noEnd) {
      expect(emitted.some((event) => event.type === "toolcall_end")).toBe(false);
    }
  });

  it("bounds nonempty streamed argument work and ignores empty fragments", () => {
    const message = finalMessage();
    let emitted = 0;
    const toolCalls = createWorkerToolCallStream({
      emit: () => {
        emitted += 1;
      },
      isCurrent: () => true,
    });
    expect(toolCalls.start(1, message)).toBe("ok");
    expect(toolCalls.delta(1, "", message)).toBe("ok");
    for (let index = 0; index < 64 * 1024 - 1; index += 1) {
      expect(toolCalls.delta(1, " ", message)).toBe("ok");
    }

    expect(toolCalls.delta(1, " ", message)).toBe("invalid");
    expect(emitted).toBe(64 * 1024);
  });

  it("synthesizes canonical arguments after deferred provider deltas", () => {
    const complete = { ...TOOL_CALL, arguments: { env: { NODE_ENV: "test" } } };
    const message = finalMessage();
    message.content = [...message.content.slice(0, -1), complete];
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    const toolCalls = createWorkerToolCallStream({
      emit: (event) => emitted.push(event),
      isCurrent: () => true,
    });

    expect(toolCalls.start(1, message)).toBe("ok");
    expect(toolCalls.delta(1, "", message)).toBe("ok");
    expect(toolCalls.end(1, message, complete)).toBe("ok");
    expect(emitted).toEqual([
      { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "lookup" },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"env":{"NODE_ENV":"test"}}' },
      { type: "toolcall_end", contentIndex: 1 },
    ]);
  });

  it.each([
    {
      phase: "toolcall_delta",
      provider: () => providerStream(finalMessage(), { omitToolEnd: true }),
      events: ["text_delta", "toolcall_start", "toolcall_delta"],
    },
    {
      phase: "toolcall_start",
      provider: () => {
        const message = finalMessage();
        const fragmented = {
          ...message,
          content: [...message.content.slice(0, -1), { ...TOOL_CALL, id: "", name: "" }],
        } satisfies AssistantMessage;
        return eventStream(
          { type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: fragmented },
          { type: "done", reason: "stop", message },
        );
      },
      events: ["toolcall_start"],
    },
  ])(
    "fences terminal synthesis when $phase rotates ownership",
    async ({ phase, provider, events }) => {
      const runtime = setup();
      runtime.stream.mockImplementation(provider);
      const emitted: Parameters<Execution["emit"]>[0][] = [];
      let current = true;
      const execution = params(request(), (event) => {
        emitted.push(event);
        if (event.type === phase) {
          current = false;
        }
      });
      execution.isCurrent = () => current;

      await expect(runtime.executor(execution)).resolves.toMatchObject({
        type: "error",
        reason: "cancelled",
      });
      expect(emitted.map((event) => event.type)).toEqual(events);
    },
  );

  it.each([
    { name: "positive cost-only", tokens: false, cost: 0.25, billed: false },
    { name: "billed zero", tokens: false, cost: 0, billed: true },
    { name: "empty snapshot", tokens: false, cost: undefined, billed: false },
  ])(
    "accounts for $name before rejecting a dangling streamed tool call",
    async ({ tokens, cost, billed }) => {
      const runtime = setup();
      const terminal = finalMessage();
      terminal.usage = structuredClone(tokens ? usage : makeZeroUsageSnapshot());
      terminal.usage.cost.total = cost ?? 0;
      if (billed) {
        terminal.usage.cost.totalOrigin = "provider-billed";
      }
      terminal.content = terminal.content.slice(0, 1);
      runtime.stream.mockImplementation(() => toolStream({ terminal, reason: "stop" }));
      const { events: usageEvents, unsubscribe } = captureUsage();

      await expect(execute(runtime).finally(unsubscribe)).resolves.toMatchObject({
        type: "error",
        reason: "provider-error",
      });
      const expectedEvents = cost === undefined ? [] : [expect.objectContaining({ costUsd: cost })];
      expect(usageEvents).toEqual(expectedEvents);
      if (cost !== undefined && !tokens) {
        expect(usageEvents[0]).not.toHaveProperty("context.used");
      }
    },
  );

  it("rejects unknown, unapproved, and profile-qualified refs", async () => {
    const runtime = setup();
    const emit = vi.fn<Execution["emit"]>();
    await runtime.withPreparedInference(async () => {
      for (const ref of ["missing-model", "known-but-unapproved", `${ALIAS}@worker-profile`]) {
        expect(await runtime.executePrepared(params(request(ref), emit))).toEqual(MODEL_ERROR);
      }
    });
    expect(runtime.stream).not.toHaveBeenCalled();
  });

  it("reuses the admitted model and auth across provider requests until the turn owner closes", async () => {
    const runtime = setup();
    await runtime.withPreparedInference(async () => {
      for (let index = 0; index < 2; index += 1) {
        await expect(runtime.executePrepared(params(request(), vi.fn()))).resolves.toMatchObject({
          type: "done",
        });
      }
      vi.mocked(workerTurnOwners.getWorkerTurnInference).mockReturnValue(undefined);
      await expect(runtime.executePrepared(params(request(), vi.fn()))).resolves.toMatchObject({
        type: "error",
        reason: "session-not-attached",
      });
    });
    expectCalls(1, runtime.prepareModel, runtime.readSessionEntry);
    expect(runtime.stream).toHaveBeenCalledTimes(2);
    expect(runtime.stream.mock.calls.map((call) => call[2]?.apiKey)).toEqual([
      AUTH_MARKER,
      AUTH_MARKER,
    ]);
  });

  it("passes the admitted search capability to the provider and revokes it after prompt policy", async () => {
    const runtime = setup();
    const searchTool = {
      name: "web_search",
      label: "Search",
      description: "Search",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    bindAgentToolExecutionLocation(searchTool, { kind: "gateway" });
    const toolRuntime = createWorkerGatewayToolRuntime({
      assertCurrent() {},
      signal: new AbortController().signal,
      prepare: async () => ({
        tools: [searchTool],
        presentation: createToolSurfacePresentationForTest(),
        policy: {
          workspaceOnly: true,
          readOnly: false,
          applyPatchEnabled: false,
          applyPatchWorkspaceOnly: true,
          imageSanitization: {},
        },
      }),
    });
    vi.spyOn(workerTurnOwners, "getWorkerTurnToolSurface").mockReturnValue(toolRuntime);
    try {
      for (const enabled of [true, false]) {
        if (!enabled) {
          toolRuntime.applyPromptToolsAllow([]);
        }
        expect(await execute(runtime)).toMatchObject({ type: "done" });
        expect(
          runtime.applyStreamPolicy.mock.lastCall?.[11]?.nativeWebSearchPolicyContext
            ?.webSearchEnabled,
        ).toBe(enabled);
      }
    } finally {
      await toolRuntime.close();
    }
  });
});

describe("worker inference session admission", () => {
  it("uses the admitted source when current config routes the session to another store", async () => {
    const changedConfig = { ...config, session: { store: "replacement-sessions.json" } };
    const runtime = setup(sessionEntry, { config: changedConfig });

    await expectDone(runtime);
    expect(runtime.resolveStream.mock.calls[0]?.[0].authProfileId).toBe(PROFILE);
    expectCalls(1, runtime.readSessionEntry, runtime.stream);
  });

  it.each([undefined, { ...sessionEntry, sessionId: "replaced-session" }])(
    "rejects a missing or replaced session before model preparation",
    async (entry) => {
      const runtime = setup();
      runtime.readSessionEntry.mockResolvedValue(entry);

      await expect(execute(runtime)).rejects.toThrow(
        "Worker model is not approved for this session",
      );
      expect(runtime.readSessionEntry).toHaveBeenCalledOnce();
      expectCalls(0, runtime.prepareModel, runtime.stream);
    },
  );

  it("rejects revoked authority after an asynchronous session read", async () => {
    const runtime = setup();
    const read = createDeferred<typeof sessionEntry>();
    runtime.readSessionEntry.mockReturnValue(read.promise);
    let current = true;
    const execution = params(request(), vi.fn());
    execution.isCurrent = () => current;
    const pending = runtime.executor(execution);
    current = false;
    read.resolve(sessionEntry);

    await expect(pending).rejects.toThrow("Worker inference source is no longer current");
    expect(runtime.readSessionEntry).toHaveBeenCalledOnce();
    expectCalls(0, runtime.prepareModel, runtime.stream);
  });
});
