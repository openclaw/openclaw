import { fileURLToPath } from "node:url";
import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { withModelTransportContext } from "./model-transport-context.js";
import { complete, completeSimple, streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

afterEach(() => vi.useRealTimers());
const emptyContext: Context = { messages: [] };
type Dispatch = (model: Model, context: Context, options?: SimpleStreamOptions) => void;

function responseStream(message: AssistantMessage, emit = true) {
  const output = createAssistantMessageEventStream();
  if (emit) {
    output.push(
      message.stopReason === "error"
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: "stop", message },
    );
  }
  output.end(emit ? undefined : message);
  return output;
}

function createCompletionRuntime(onDispatch?: Dispatch) {
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  const model = makeProviderModelFixture({
    api: "test-runtime-host-api",
    provider: "test-runtime-host",
    id: "test-runtime-host-model",
    baseUrl: "https://example.test",
  });
  const message = makeAgentAssistantMessage({
    content: [{ type: "text", text: "configured" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
  });
  const providerStream = vi.fn((...args: Parameters<Dispatch>) => {
    onDispatch?.(...args);
    return responseStream(message);
  });
  registry.registerApiProvider({
    api: model.api,
    stream: providerStream,
    streamSimple: providerStream,
  });
  const boundModel = bindModelLlmRuntime(model, runtime);
  const run = (options?: SimpleStreamOptions, assertCurrent?: () => void) =>
    completeSimple(boundModel, emptyContext, options, assertCurrent);
  const rateLimit = (organization: string, retryAfterMs: number): AssistantMessage => ({
    ...message,
    stopReason: "error",
    retryAfterMs,
    errorMessage: `Rate limit reached in organization org-synthetic-${organization} on tokens per min (TPM).`,
  });
  const limit = (organization: string, retryAfterMs: number) =>
    responseStream(rateLimit(organization, retryAfterMs), false);
  return { model: boundModel, runtime, message, providerStream, run, limit, rateLimit };
}

async function createLimitedRuntime(organization: string, options: SimpleStreamOptions) {
  const fixture = createCompletionRuntime();
  await fixture.run();
  vi.useFakeTimers();
  fixture.providerStream.mockImplementationOnce(() => fixture.limit(organization, 1000));
  await fixture.run(options);
  return fixture;
}

it("installs runtime transport ports before direct preparation and bare completion", async () => {
  const inertWrapper = getAiTransportHost().plugin.wrapSimpleCompletionStream;
  const { model, runtime, message, providerStream } = createCompletionRuntime(
    (_runtimeModel, context) => {
      expect(getAiTransportHost().plugin.wrapSimpleCompletionStream).not.toBe(inertWrapper);
      expect(context.messages).toEqual([]);
    },
  );

  const directModel = bindModelLlmRuntime(
    attachModelProviderRuntimePluginHandle(model, {
      provider: model.provider,
      plugin: {
        id: model.provider,
        label: "Completion fixture",
        auth: [],
        wrapSimpleCompletionStreamFn: ({ streamFn }) =>
          streamFn &&
          ((target, context, options) =>
            streamFn(target, context, {
              ...options,
              headers: { ...options?.headers, "x-runtime-host": "prepared" },
            })),
      },
    }),
    runtime,
  );
  const { completeWithPreparedSimpleCompletionModel } =
    await import("../agents/simple-completion-execution.js");
  await expect(
    completeWithPreparedSimpleCompletionModel({
      model: directModel,
      auth: { apiKey: "fixture-key", source: "test", mode: "api-key" },
      context: emptyContext,
    }),
  ).resolves.toEqual(message);
  await expect(completeSimple(model, emptyContext)).resolves.toEqual(message);
  await expect(complete(model, emptyContext)).resolves.toEqual(message);
  expect(providerStream.mock.calls.map((call) => call[2]?.headers)).toEqual([
    { "x-runtime-host": "prepared" },
    undefined,
    undefined,
  ]);
});

it.each(
  (["host-prepared", "full"] as const).flatMap((entry) =>
    (["current", "retired", "aborted"] as const).map((authority) => ({ entry, authority })),
  ),
)(
  "checks $authority $entry authority after transport initialization",
  async ({ entry, authority }) => {
    const { model, message, providerStream } = createCompletionRuntime();
    const controller = new AbortController();
    const authorityError = new Error("Completion owner retired.");
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw authorityError;
      }
    };
    const options = { signal: controller.signal };
    const completion =
      entry === "full"
        ? complete(model, emptyContext, options, assertCurrent)
        : (
            await import("../agents/host-prepared-isolated-completion.js")
          ).runHostPreparedIsolatedCompletion({
            provider: model.provider,
            modelId: model.id,
            authorization: {
              owner: "host",
              model,
              auth: { mode: "api-key", source: "test", apiKey: "synthetic-completion-key" },
            },
            config: {},
            agentId: "main",
            agentDir: "/test/agent",
            workspaceDir: "/test/workspace",
            systemPrompt: "Return a brief title.",
            prompt: "Title this chat.",
            timeoutMs: 10_000,
            abortSignal: controller.signal,
            assertCurrent,
          });
    // Even a warm transport host yields before it invokes the provider.
    current = authority !== "retired";
    if (authority === "aborted") {
      controller.abort(authorityError);
    }

    if (authority === "current") {
      await expect(completion).resolves.toEqual(
        entry === "full" ? message : { assistant: message },
      );
      expect(providerStream).toHaveBeenCalledOnce();
      const [, sentContext, sentOptions] = providerStream.mock.calls[0]!;
      if (entry === "full") {
        expect(sentContext.messages).toEqual([]);
        expect(sentOptions).toBe(options);
      } else {
        expect(sentContext.messages).toEqual([
          { role: "user", content: "Title this chat.", timestamp: expect.any(Number) },
        ]);
        expect(sentOptions).toMatchObject({ apiKey: "synthetic-completion-key" });
        expect(sentOptions).not.toHaveProperty("assertCurrent");
      }
    } else {
      await expect(completion).rejects.toBe(authorityError);
      expect(providerStream).not.toHaveBeenCalled();
    }
    expect(controller.signal.aborted).toBe(authority === "aborted");
  },
);
it("paces 30 shared-account sessions once per request and admits interactive work first", async () => {
  const { model, runtime, message, providerStream, run, rateLimit } = createCompletionRuntime();
  await run();
  const { resolveEmbeddedAgentStream } =
    await import("../agents/embedded-agent-runner/stream-resolution.js");
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const calls: string[] = [];
  let limited = true;
  providerStream.mockImplementation((_model, _context, options) => {
    calls.push(options?.sessionId ?? "seed");
    return responseStream(
      limited ? { ...rateLimit("priority", 1000), errorCode: "rate_limit_exceeded" } : message,
    );
  });
  const embedded = resolveEmbeddedAgentStream({
    model,
    llmRuntime: runtime,
    currentStreamFn: streamSimple,
    providerStreamFn: streamSimple,
    sessionId: "seed",
    resolvedApiKey: "synthetic-priority-key",
  }).streamFn;
  const seed = await embedded(model, emptyContext);
  await expect(getEventStreamCompletion(seed)).resolves.toMatchObject({ stopReason: "error" });
  for await (const event of seed) {
    expect(event.type).toBe("error");
  }
  await seed.result();
  limited = false;
  await run({ apiKey: "unrelated-account-key", sessionId: "other-account" });
  const background = Array.from({ length: 20 }, (_, index) =>
    run({ apiKey: "synthetic-priority-key", sessionId: `background-${index}` }),
  );
  const waits: number[] = [];
  const stoppedWaiting = vi.fn();
  const interactive = Array.from({ length: 10 }, (_, index) =>
    withModelTransportContext(
      {
        requestId: `interactive-${index}`,
        priority: "interactive",
        onRateLimitWait: (retryAt) => {
          waits.push(retryAt);
          return stoppedWaiting;
        },
      },
      async () =>
        (
          await embedded(
            bindModelLlmRuntime({ ...model, id: "fallback-sibling" }, runtime),
            emptyContext,
            { apiKey: "synthetic-priority-key", sessionId: `interactive-${index}` },
          )
        ).result(),
    ),
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(calls).toEqual(["seed", "other-account"]);
  expect(waits).toHaveLength(10);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toEqual(["seed", "other-account", "interactive-0"]);
  expect(stoppedWaiting).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(7500);
  await expect(Promise.all([...background, ...interactive])).resolves.toEqual(
    Array.from({ length: 30 }, () => message),
  );
  expect(calls.slice(2)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => `interactive-${index}`),
    ...Array.from({ length: 20 }, (_, index) => `background-${index}`),
  ]);
  expect(stoppedWaiting).toHaveBeenCalledTimes(10);

  // Ongoing successful traffic must not keep the recovery gate alive forever.
  await vi.advanceTimersByTimeAsync(60_000 - Date.now());
  const active = run({ apiKey: "synthetic-priority-key" });
  await vi.advanceTimersByTimeAsync(0);
  await active;
  await vi.advanceTimersByTimeAsync(1001);
  const recovered = [0, 1].map(() => run({ apiKey: "synthetic-priority-key" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toHaveLength(35);
  await Promise.all(recovered);
});

it("merges credentials identified by the same organization and extends queued waits", async () => {
  const { message, providerStream, run, limit } = await createLimitedRuntime("merge", {
    apiKey: "merge-first-key",
  });
  const first = run({ apiKey: "merge-first-key" });
  await vi.advanceTimersByTimeAsync(100);
  providerStream.mockImplementationOnce(() => limit("merge", 2000));
  await run({ apiKey: "merge-second-key" });
  const second = run({ apiKey: "merge-second-key" });
  providerStream.mockClear();
  await vi.advanceTimersByTimeAsync(1999);
  expect(providerStream).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(providerStream).toHaveBeenCalledOnce();
  expect(providerStream.mock.calls[0]?.[2]?.apiKey).toBe("merge-first-key");
  await vi.advanceTimersByTimeAsync(250);
  await expect(Promise.all([first, second])).resolves.toEqual([message, message]);
  await vi.advanceTimersByTimeAsync(60_000);
});

it("returns excessive shared floors to failover, including a floor extended while queued", async () => {
  const options = { apiKey: "synthetic-cap-key", maxRetryDelayMs: 1500 };
  const { model, message, providerStream, run, limit } = await createLimitedRuntime("cap", options);
  const queued = run(options);
  const queuedProof = expect(queued).rejects.toMatchObject({ reason: "rate_limit", status: 429 });
  await vi.advanceTimersByTimeAsync(1);
  providerStream.mockImplementationOnce(() => limit("cap", 90_000));
  await run({ apiKey: "synthetic-cap-second-key" });
  await queuedProof;
  providerStream.mockClear();

  await expect(run({ apiKey: options.apiKey })).rejects.toMatchObject({
    reason: "rate_limit",
    status: 429,
    message: expect.stringContaining("Retry-After: 90 seconds"),
  });
  await expect(streamSimple(model, emptyContext, options).result()).resolves.toMatchObject({
    stopReason: "error",
    errorMessage: expect.stringContaining("Retry-After: 90 seconds"),
  });
  expect(providerStream).not.toHaveBeenCalled();
  const uncapped = run({ ...options, maxRetryDelayMs: 0 });
  await vi.advanceTimersByTimeAsync(89_999);
  expect(providerStream).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(uncapped).resolves.toEqual(message);
  expect(providerStream).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
});

it("cancels admission and rechecks authority without sending queued requests", async () => {
  const { resolveEmbeddedAgentStream } =
    await import("../agents/embedded-agent-runner/stream-resolution.js");
  const options = { apiKey: "synthetic-cancel-key" };
  const { model, runtime, providerStream, run } = await createLimitedRuntime("cancel", options);
  providerStream.mockClear();
  const controller = new AbortController();
  const aborted = run({ ...options, signal: controller.signal });
  const abortProof = expect(aborted).rejects.toThrow("stopped");
  const embedded = resolveEmbeddedAgentStream({
    model,
    llmRuntime: runtime,
    currentStreamFn: providerStream,
    providerStreamFn: providerStream,
    sessionId: "cancel-run-signal",
    resolvedApiKey: options.apiKey,
    signal: controller.signal,
  }).streamFn;
  const embeddedAbortProof = expect(Promise.resolve(embedded(model, emptyContext))).rejects.toThrow(
    "stopped",
  );
  let current = true;
  const retired = run(options, () => {
    if (!current) {
      throw new Error("retired");
    }
  });
  const retiredProof = expect(retired).rejects.toThrow("retired");
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(new Error("stopped"));
  current = false;
  await vi.advanceTimersByTimeAsync(1250);
  await Promise.all([abortProof, embeddedAbortProof, retiredProof]);
  expect(providerStream).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
});

it("releases admitted request callbacks across completion, retry, and abandoned consumption", async ({
  signal,
}) => {
  // V8 collection proof runs in Node even when the surrounding suite uses Bun.
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/provider-rate-limit-retention.ts",
      "--turns",
      "11",
      "--payload-bytes",
      "8",
    ],
    { ...process.env, NODE_OPTIONS: "" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    turns: 11,
    retainedCallbacks: 0,
    retainedPayloadBytes: 0,
  });
});
