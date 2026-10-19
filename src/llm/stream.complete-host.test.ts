import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import { getEventStreamCompletion } from "@openclaw/ai/internal/runtime";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
} from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { withModelTransportContext } from "./model-transport-context.js";
import { complete, completeSimple, streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

afterEach(() => vi.useRealTimers());

function createCompletionRuntime(
  onDispatch?: (model: Model, context: Context, options?: SimpleStreamOptions) => void,
) {
  const registry = createApiRegistry();
  const runtime = createLlmRuntime(registry);
  const model = {
    api: "test-runtime-host-api",
    provider: "test-runtime-host",
    id: "test-runtime-host-model",
    name: "Test Runtime Host Model",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 512,
  } satisfies Model;
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "configured" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: Date.now(),
  } satisfies AssistantMessage;
  const providerStream = vi.fn(
    (
      runtimeModel: Model,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStreamContract => {
      onDispatch?.(runtimeModel, context, options);
      const output = createAssistantMessageEventStream();
      output.push({ type: "done", reason: "stop", message });
      output.end();
      return output;
    },
  );
  registry.registerApiProvider({
    api: model.api,
    stream: providerStream,
    streamSimple: providerStream,
  });
  return { model: bindModelLlmRuntime(model, runtime), runtime, message, providerStream };
}

describe("LLM completion transport host", () => {
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
        context: { messages: [] },
      }),
    ).resolves.toEqual(message);
    await expect(completeSimple(model, { messages: [] })).resolves.toEqual(message);
    await expect(complete(model, { messages: [] })).resolves.toEqual(message);
    expect(providerStream.mock.calls.map((call) => call[2]?.headers)).toEqual([
      { "x-runtime-host": "prepared" },
      undefined,
      undefined,
    ]);
  });

  it.each(["current", "retired", "aborted"] as const)(
    "checks %s host-prepared authority after deferred transport initialization",
    async (authority) => {
      const { runHostPreparedIsolatedCompletion } =
        await import("../agents/host-prepared-isolated-completion.js");
      const { model, message, providerStream } = createCompletionRuntime(
        (_runtimeModel, context, options) => {
          expect(context.messages).toEqual([
            { role: "user", content: "Title this chat.", timestamp: expect.any(Number) },
          ]);
          expect(options).toMatchObject({ apiKey: "synthetic-completion-key" });
          expect(options).not.toHaveProperty("assertCurrent");
        },
      );
      const controller = new AbortController();
      const authorityError = new Error("Completion owner retired.");
      let current = true;
      const completion = runHostPreparedIsolatedCompletion({
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
        assertCurrent: () => {
          if (!current) {
            throw authorityError;
          }
        },
      });
      // Even a warm transport host yields before it invokes the provider.
      current = authority !== "retired";
      if (authority === "aborted") {
        controller.abort(authorityError);
      }

      if (authority === "current") {
        await expect(completion).resolves.toEqual({ assistant: message });
        expect(providerStream).toHaveBeenCalledOnce();
      } else {
        await expect(completion).rejects.toBe(authorityError);
        expect(providerStream).not.toHaveBeenCalled();
      }
      expect(controller.signal.aborted).toBe(authority === "aborted");
    },
  );

  it.each(["current", "retired", "aborted"] as const)(
    "checks %s full-completion authority after transport initialization",
    async (authority) => {
      const { model, message, providerStream } = createCompletionRuntime();
      const controller = new AbortController();
      const retired = new Error("Completion owner retired.");
      const options = { signal: controller.signal };
      let current = true;
      const completion = complete(model, { messages: [] }, options, () => {
        if (!current) {
          throw retired;
        }
      });
      // Even a warm transport host yields before it invokes the provider.
      current = authority !== "retired";
      if (authority === "aborted") {
        controller.abort(retired);
      }

      if (authority === "current") {
        await expect(completion).resolves.toEqual(message);
        expect(providerStream).toHaveBeenCalledOnce();
        expect(providerStream.mock.calls[0]?.[2]).toBe(options);
      } else {
        await expect(completion).rejects.toBe(retired);
        expect(providerStream).not.toHaveBeenCalled();
      }
      expect(controller.signal.aborted).toBe(authority === "aborted");
    },
  );
  it("paces 30 shared-account sessions once per request and admits interactive work first", async () => {
    const { model, runtime, message, providerStream } = createCompletionRuntime();
    await completeSimple(model, { messages: [] });
    const { resolveEmbeddedAgentStream } =
      await import("../agents/embedded-agent-runner/stream-resolution.js");
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const calls: string[] = [];
    let limited = true;
    providerStream.mockImplementation((_model, _context, options) => {
      calls.push(options?.sessionId ?? "seed");
      const output = createAssistantMessageEventStream();
      if (limited) {
        output.push({
          type: "error",
          reason: "error",
          error: {
            ...message,
            stopReason: "error",
            errorCode: "rate_limit_exceeded",
            errorMessage:
              "Rate limit reached for test in organization org-synthetic-priority on tokens per min (TPM).",
            retryAfterMs: 1000,
          },
        });
      } else {
        output.push({ type: "done", reason: "stop", message });
      }
      output.end();
      return output;
    });
    const embedded = resolveEmbeddedAgentStream({
      model,
      llmRuntime: runtime,
      currentStreamFn: streamSimple,
      providerStreamFn: streamSimple,
      sessionId: "seed",
      resolvedApiKey: "synthetic-priority-key",
    }).streamFn;
    const seed = await embedded(model, { messages: [] });
    await expect(getEventStreamCompletion(seed)).resolves.toMatchObject({ stopReason: "error" });
    for await (const event of seed) {
      expect(event.type).toBe("error");
    }
    await seed.result();
    limited = false;
    await completeSimple(
      model,
      { messages: [] },
      {
        apiKey: "unrelated-account-key",
        sessionId: "other-account",
      },
    );
    const background = Array.from({ length: 20 }, (_, index) =>
      completeSimple(
        model,
        { messages: [] },
        { apiKey: "synthetic-priority-key", sessionId: `background-${index}` },
      ),
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
              { messages: [] },
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
    const active = completeSimple(model, { messages: [] }, { apiKey: "synthetic-priority-key" });
    await vi.advanceTimersByTimeAsync(0);
    await active;
    await vi.advanceTimersByTimeAsync(1001);
    const recovered = [0, 1].map(() =>
      completeSimple(model, { messages: [] }, { apiKey: "synthetic-priority-key" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(35);
    await Promise.all(recovered);
  });

  it("merges credentials identified by the same organization and extends queued waits", async () => {
    const { model, message, providerStream } = createCompletionRuntime();
    await completeSimple(model, { messages: [] });
    vi.useFakeTimers();
    const limited = (retryAfterMs: number) => {
      const output = createAssistantMessageEventStream();
      output.end({
        ...message,
        stopReason: "error",
        retryAfterMs,
        errorMessage:
          "Rate limit reached in organization org-synthetic-merge on tokens per min (TPM).",
      });
      return output;
    };
    providerStream.mockImplementationOnce(() => limited(1000));
    await completeSimple(model, { messages: [] }, { apiKey: "merge-first-key" });
    const first = completeSimple(model, { messages: [] }, { apiKey: "merge-first-key" });
    await vi.advanceTimersByTimeAsync(100);
    providerStream.mockImplementationOnce(() => limited(2000));
    await completeSimple(model, { messages: [] }, { apiKey: "merge-second-key" });
    const second = completeSimple(model, { messages: [] }, { apiKey: "merge-second-key" });
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
    const { model, message, providerStream } = createCompletionRuntime();
    await completeSimple(model, { messages: [] });
    vi.useFakeTimers();
    const limited = (retryAfterMs: number) => {
      const output = createAssistantMessageEventStream();
      output.end({
        ...message,
        stopReason: "error",
        retryAfterMs,
        errorMessage:
          "Rate limit reached in organization org-synthetic-cap on tokens per min (TPM).",
      });
      return output;
    };
    const options = { apiKey: "synthetic-cap-key", maxRetryDelayMs: 1500 };
    providerStream.mockImplementationOnce(() => limited(1000));
    await completeSimple(model, { messages: [] }, options);
    const queued = completeSimple(model, { messages: [] }, options);
    const queuedProof = expect(queued).rejects.toMatchObject({ reason: "rate_limit", status: 429 });
    await vi.advanceTimersByTimeAsync(1);
    providerStream.mockImplementationOnce(() => limited(90_000));
    await completeSimple(model, { messages: [] }, { apiKey: "synthetic-cap-second-key" });
    await queuedProof;
    providerStream.mockClear();

    await expect(
      completeSimple(model, { messages: [] }, { apiKey: options.apiKey }),
    ).rejects.toMatchObject({
      reason: "rate_limit",
      status: 429,
      message: expect.stringContaining("Retry-After: 90 seconds"),
    });
    await expect(streamSimple(model, { messages: [] }, options).result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("Retry-After: 90 seconds"),
    });
    expect(providerStream).not.toHaveBeenCalled();
    const uncapped = completeSimple(model, { messages: [] }, { ...options, maxRetryDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(providerStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(uncapped).resolves.toEqual(message);
    expect(providerStream).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("cancels admission and rechecks authority without sending queued requests", async () => {
    const { model, runtime, message, providerStream } = createCompletionRuntime();
    await completeSimple(model, { messages: [] });
    const { resolveEmbeddedAgentStream } =
      await import("../agents/embedded-agent-runner/stream-resolution.js");
    vi.useFakeTimers();
    providerStream.mockImplementationOnce(() => {
      const output = createAssistantMessageEventStream();
      output.end({
        ...message,
        stopReason: "error",
        errorMessage:
          "Rate limit reached for test in organization org-synthetic-cancel on tokens per min (TPM).",
        retryAfterMs: 1000,
      });
      return output;
    });
    const options = { apiKey: "synthetic-cancel-key" };
    await completeSimple(model, { messages: [] }, options);
    providerStream.mockClear();
    const controller = new AbortController();
    const aborted = completeSimple(
      model,
      { messages: [] },
      { ...options, signal: controller.signal },
    );
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
    const embeddedAbortProof = expect(
      Promise.resolve(embedded(model, { messages: [] })),
    ).rejects.toThrow("stopped");
    let current = true;
    const retired = completeSimple(model, { messages: [] }, options, () => {
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
});
