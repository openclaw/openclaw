import { fileURLToPath } from "node:url";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterEach, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { withModelTransportContext } from "./model-transport-context.js";
import { admitProviderRateLimitStream } from "./provider-rate-limit-stream.js";
import { withProviderRateLimitRetryDeadline } from "./provider-rate-limit.js";
import { complete, completeSimple, streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

afterEach(() => vi.useRealTimers());
const emptyContext: Context = { messages: [] };

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

function createCompletionRuntime(wrap = false) {
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
  });
  const providerStream = vi.fn((..._args: Parameters<typeof streamSimple>) =>
    responseStream(message),
  );
  registry.registerApiProvider({
    api: model.api,
    stream: providerStream,
    streamSimple: providerStream,
  });
  const boundModel = bindModelLlmRuntime(
    wrap
      ? attachModelProviderRuntimePluginHandle(model, {
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
        })
      : model,
    runtime,
  );
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
  const embedded = async (apiKey: string, transport = streamSimple, signal?: AbortSignal) => {
    const { resolveEmbeddedAgentStream } =
      await import("../agents/embedded-agent-runner/stream-resolution.js");
    return resolveEmbeddedAgentStream({
      model: boundModel,
      llmRuntime: runtime,
      currentStreamFn: transport,
      providerStreamFn: transport,
      sessionId: "seed",
      resolvedApiKey: apiKey,
      signal,
    }).streamFn;
  };
  return { model: boundModel, runtime, message, providerStream, run, limit, rateLimit, embedded };
}

async function createLimitedRuntime(organization: string, options: SimpleStreamOptions) {
  const fixture = createCompletionRuntime();
  await fixture.run();
  vi.useFakeTimers();
  fixture.providerStream.mockImplementationOnce(() => fixture.limit(organization, 1000));
  await fixture.run(options);
  return fixture;
}

it.each(
  (["prepared", "full"] as const).flatMap((entry) =>
    (["current", "retired", "aborted"] as const).map((authority) => ({ entry, authority })),
  ),
)(
  "checks $authority $entry authority after transport initialization",
  async ({ entry, authority }) => {
    const { model, message, providerStream } = createCompletionRuntime(entry === "prepared");
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
            await import("../agents/simple-completion-execution.js")
          ).completeWithPreparedSimpleCompletionModel({
            model,
            auth: { mode: "api-key", source: "test", apiKey: "synthetic-completion-key" },
            context: emptyContext,
            options,
            assertCurrent,
          });
    // Even a warm transport host yields before it invokes the provider.
    current = authority !== "retired";
    if (authority === "aborted") {
      controller.abort(authorityError);
    }

    if (authority === "current") {
      await expect(completion).resolves.toEqual(message);
      if (entry === "prepared") {
        expect(providerStream.mock.calls[0]?.[2]).toMatchObject({
          apiKey: "synthetic-completion-key",
          headers: { "x-runtime-host": "prepared" },
        });
      }
    } else {
      await expect(completion).rejects.toBe(authorityError);
      expect(providerStream).not.toHaveBeenCalled();
    }
  },
);
it("leaves unkeyed and inherited stream consumers intact while gating a changed account", async () => {
  const { model, message, rateLimit } = createCompletionRuntime();
  const unkeyed = responseStream(message);
  const iterate = unkeyed[Symbol.asyncIterator];
  const result = unkeyed.result.bind(unkeyed);
  unkeyed.result = result;
  expect(await admitProviderRateLimitStream(model, undefined, () => unkeyed)).toBe(unkeyed);
  expect(unkeyed[Symbol.asyncIterator]).toBe(iterate);
  expect(unkeyed).toHaveProperty("result", result);
  await expect(unkeyed.result()).resolves.toBe(message);

  vi.useFakeTimers();
  const source = responseStream(rateLimit("changed-account", 1000));
  const sourceIterate = source[Symbol.asyncIterator];
  const sourceResult = source.result.bind(source);
  source.result = sourceResult;
  const sameAccount = await admitProviderRateLimitStream(
    model,
    { apiKey: "synthetic-outer-account" },
    async (admittedOptions) => {
      const inherited = await admitProviderRateLimitStream(model, admittedOptions, (forwarded) => {
        expect(forwarded).toBe(admittedOptions);
        return source;
      });
      expect(inherited[Symbol.asyncIterator]).toBe(sourceIterate);
      expect(inherited).toHaveProperty("result", sourceResult);
      // A delegated request using a different account still owns its observation.
      const changedOptions = { ...admittedOptions, apiKey: "synthetic-changed-account" };
      return admitProviderRateLimitStream(model, changedOptions, (forwarded) => {
        expect(forwarded).not.toBe(changedOptions);
        expect(forwarded.apiKey).toBe(changedOptions.apiKey);
        return inherited;
      });
    },
  );
  const events = [];
  for await (const event of sameAccount) {
    events.push(event);
  }
  expect(events).toEqual([
    { type: "error", reason: "error", error: rateLimit("changed-account", 1000) },
  ]);
  await expect(sameAccount.result()).resolves.toEqual(rateLimit("changed-account", 1000));
  const start = vi.fn(() => responseStream(message));
  await expect(
    admitProviderRateLimitStream(
      model,
      { apiKey: "synthetic-changed-account", maxRetryDelayMs: 1 },
      start,
    ),
  ).rejects.toMatchObject({ status: 429 });
  expect(start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(61000);
});

it("paces 30 shared-account sessions once per request and admits interactive work first", async () => {
  const { model, message, providerStream, run, rateLimit, embedded } = createCompletionRuntime();
  await run();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  providerStream
    .mockClear()
    .mockImplementationOnce(() =>
      responseStream({ ...rateLimit("priority", 1000), errorCode: "rate_limit_exceeded" }),
    );
  const calls = () => providerStream.mock.calls.map((call) => call[2]?.sessionId ?? "seed");
  const embeddedStream = await embedded("synthetic-priority-key");
  const seed = await embeddedStream(model, emptyContext);
  await expect(seed.result()).resolves.toMatchObject({ stopReason: "error" });
  await run({ apiKey: "unrelated-account-key", sessionId: "other-account" });
  const background = Array.from({ length: 20 }, (_, index) =>
    run({ apiKey: "synthetic-priority-key", sessionId: `background-${index}` }),
  );
  const stoppedWaiting = vi.fn();
  const onRateLimitWait = vi.fn(() => stoppedWaiting);
  const interactive = Array.from({ length: 10 }, (_, index) =>
    withModelTransportContext(
      {
        requestId: `interactive-${index}`,
        priority: "interactive",
        onRateLimitWait,
      },
      async () =>
        (
          await embeddedStream(model, emptyContext, {
            apiKey: "synthetic-priority-key",
            sessionId: `interactive-${index}`,
          })
        ).result(),
    ),
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(calls()).toEqual(["seed", "other-account"]);
  expect(onRateLimitWait).toHaveBeenCalledTimes(10);
  expect(onRateLimitWait).toHaveBeenCalledWith(Date.now() + 1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls()).toEqual(["seed", "other-account", "interactive-0"]);
  expect(stoppedWaiting).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(7500);
  await expect(Promise.all([...background, ...interactive])).resolves.toEqual(
    Array.from({ length: 30 }, () => message),
  );
  expect(calls().slice(2)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => `interactive-${index}`),
    ...Array.from({ length: 20 }, (_, index) => `background-${index}`),
  ]);
  expect(stoppedWaiting).toHaveBeenCalledTimes(10);

  // Ongoing successful traffic must not keep the recovery gate alive forever.
  await vi.advanceTimersByTimeAsync(60_000 - performance.now());
  const active = run({ apiKey: "synthetic-priority-key" });
  await vi.advanceTimersByTimeAsync(0);
  await active;
  await vi.advanceTimersByTimeAsync(1001);
  const recovered = [0, 1].map(() => run({ apiKey: "synthetic-priority-key" }));
  await vi.advanceTimersByTimeAsync(0);
  expect(calls()).toHaveLength(35);
  await Promise.all(recovered);
});

it("shares TPM waits across runs of one model without delaying another model on the same organization", async () => {
  const { model, runtime, message, providerStream, run, limit } = createCompletionRuntime();
  await run();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  const options = {
    apiKey: "synthetic-model-scoped-key",
    headers: { "OpenAI-Organization": "org-synthetic-model-scoped" },
  };
  providerStream.mockImplementationOnce(() => limit("model-scoped", 1000));
  await run(options);
  vi.setSystemTime(Date.now() + 90_000);
  providerStream.mockClear();
  const primary = withProviderRateLimitRetryDeadline(performance.now() + 1200, () =>
    run({ ...options, sessionId: "another-primary-run" }),
  );
  const primaryOutcome = Promise.allSettled([primary]);
  const fallbackModel = bindModelLlmRuntime({ ...model, id: "fallback-sibling" }, runtime);
  const fallback = completeSimple(fallbackModel, emptyContext, {
    ...options,
    sessionId: "fallback-run",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(providerStream.mock.calls.map((call) => call[2]?.sessionId)).toEqual(["fallback-run"]);
  await expect(fallback).resolves.toEqual(message);
  await vi.advanceTimersByTimeAsync(999);
  expect(providerStream).toHaveBeenCalledOnce();
  vi.setSystemTime(Date.now() - 180_000);
  await vi.advanceTimersByTimeAsync(1);
  await expect(primaryOutcome).resolves.toEqual([{ status: "fulfilled", value: message }]);
  expect(providerStream).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
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

it("bounds retry admission while shared floors extend and interactive peers remain queued", async () => {
  const options = { apiKey: "synthetic-deadline-key" };
  const { providerStream, run, limit } = await createLimitedRuntime("deadline", options);
  providerStream.mockClear();
  const retry = withProviderRateLimitRetryDeadline(performance.now() + 1200, () =>
    run({ ...options, sessionId: "bounded-retry" }),
  );
  const failed = expect(retry).rejects.toMatchObject({ reason: "rate_limit", status: 429 });
  await vi.advanceTimersByTimeAsync(100);
  providerStream.mockImplementationOnce(() => limit("deadline", 1000));
  await run({ apiKey: "synthetic-deadline-second-key" });
  const peers = Array.from({ length: 5 }, (_, index) =>
    withModelTransportContext({ requestId: `peer-${index}`, priority: "interactive" }, () =>
      run({ ...options, sessionId: `peer-${index}` }),
    ),
  );
  await vi.advanceTimersByTimeAsync(1100);
  await failed;
  expect(providerStream.mock.calls.some((call) => call[2]?.sessionId === "bounded-retry")).toBe(
    false,
  );
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all(peers);
  await vi.advanceTimersByTimeAsync(60_000);
});

it("cancels admission and rechecks authority without sending queued requests", async () => {
  const options = { apiKey: "synthetic-cancel-key" };
  const { model, providerStream, run, embedded } = await createLimitedRuntime("cancel", options);
  providerStream.mockClear();
  const controller = new AbortController();
  const aborted = run({ ...options, signal: controller.signal });
  const abortProof = expect(aborted).rejects.toThrow("stopped");
  const embeddedStream = await embedded(options.apiKey, providerStream, controller.signal);
  const embeddedAbortProof = expect(
    Promise.resolve(embeddedStream(model, emptyContext)),
  ).rejects.toThrow("stopped");
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

it("releases callbacks across completion, retry, and abandoned consumption", async ({ signal }) => {
  // V8 collection proof runs in Node even when the surrounding suite uses Bun.
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/provider-rate-limit-retention.ts",
      "--turns=11",
      "--payload-bytes=8",
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
  expect([result.error, result.status], result.stderr).toEqual([undefined, 0]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    turns: 11,
    retainedCallbacks: 0,
    retainedPayloadBytes: 0,
  });
});
