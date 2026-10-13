import { createApiRegistry, createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type {
  AssistantMessage,
  AssistantMessageEventStreamContract,
  Context,
  Model,
  SimpleStreamOptions,
} from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { createZeroUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { complete, completeSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

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
});
