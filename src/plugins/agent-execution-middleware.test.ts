import type { StreamFn } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithAgentStreamingLlmMiddlewares } from "./agent-streaming-llm-middleware.js";
import { executeToolWithAgentToolCallMiddlewares } from "./agent-tool-call-middleware.js";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

describe("agent execution middleware", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("wraps streaming LLM execution in priority order", async () => {
    const registry = createEmptyPluginRegistry();
    const seenContexts: unknown[] = [];
    const baseStreamFn: StreamFn = ((
      _model: Parameters<StreamFn>[0],
      context: Parameters<StreamFn>[1],
    ) => {
      seenContexts.push(context);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text", text: "ok" };
        },
      };
    }) as unknown as StreamFn;

    registry.agentStreamingLlmMiddlewares.push(
      {
        pluginId: "low",
        pluginName: "Low",
        rawHandler: (ctx) => ctx.streamFn,
        handler: (ctx) =>
          ((model, context, options) => {
            const nextContext = {
              ...(context as object),
              order: [...((context as { order?: string[] }).order ?? []), "low"],
            } as unknown as Parameters<StreamFn>[1];
            return ctx.streamFn(model, nextContext, options);
          }) as StreamFn,
        runtimes: ["pi"],
        priority: 5,
        source: "test",
      },
      {
        pluginId: "high",
        pluginName: "High",
        rawHandler: (ctx) => ctx.streamFn,
        handler: (ctx) =>
          ((model, context, options) => {
            const nextContext = {
              ...(context as object),
              order: [...((context as { order?: string[] }).order ?? []), "high"],
            } as unknown as Parameters<StreamFn>[1];
            return ctx.streamFn(model, nextContext, options);
          }) as StreamFn,
        runtimes: ["pi"],
        priority: 50,
        source: "test",
      },
    );
    initializeGlobalHookRunner(registry);

    const wrapped = wrapStreamFnWithAgentStreamingLlmMiddlewares({
      provider: "openai",
      modelId: "gpt-test",
      streamFn: baseStreamFn,
    });
    for await (const chunk of wrapped(
      {} as never,
      {} as never,
      {} as never,
    ) as AsyncIterable<unknown>) {
      void chunk;
      // drain
    }

    expect(seenContexts).toEqual([{ order: ["high", "low"] }]);
  });

  it("lets tool-call middleware rewrite params and wrap execution", async () => {
    const registry = createEmptyPluginRegistry();
    const baseExecute = vi.fn(async (params: unknown) => ({ params }));
    registry.agentToolCallMiddlewares.push(
      {
        pluginId: "low",
        pluginName: "Low",
        rawHandler: async (ctx) => await ctx.execute(ctx.params),
        handler: async (ctx) =>
          await ctx.execute({
            ...(ctx.params as object),
            low: true,
          }),
        runtimes: ["pi"],
        priority: 5,
        source: "test",
      },
      {
        pluginId: "high",
        pluginName: "High",
        rawHandler: async (ctx) => await ctx.execute(ctx.params),
        handler: async (ctx) =>
          await ctx.execute({
            ...(ctx.params as object),
            high: true,
          }),
        runtimes: ["pi"],
        priority: 50,
        source: "test",
      },
    );
    initializeGlobalHookRunner(registry);

    await expect(
      executeToolWithAgentToolCallMiddlewares({
        toolName: "demo",
        params: { original: true },
        execute: baseExecute,
      }),
    ).resolves.toEqual({
      params: {
        original: true,
        high: true,
        low: true,
      },
    });
    expect(baseExecute).toHaveBeenCalledWith({
      original: true,
      high: true,
      low: true,
    });
  });

  it("lets tool-call middleware block execution", async () => {
    const registry = createEmptyPluginRegistry();
    const baseExecute = vi.fn(async () => ({ executed: true }));
    registry.agentToolCallMiddlewares.push({
      pluginId: "blocker",
      pluginName: "Blocker",
      rawHandler: () => ({ blocked: true }),
      handler: () => ({ blocked: true }),
      runtimes: ["pi"],
      priority: 10,
      source: "test",
    });
    initializeGlobalHookRunner(registry);

    await expect(
      executeToolWithAgentToolCallMiddlewares({
        toolName: "demo",
        params: {},
        execute: baseExecute,
      }),
    ).resolves.toEqual({ blocked: true });
    expect(baseExecute).not.toHaveBeenCalled();
  });

  it("lets tool-call middleware throw without running the tool", async () => {
    const registry = createEmptyPluginRegistry();
    const baseExecute = vi.fn(async () => ({ executed: true }));
    registry.agentToolCallMiddlewares.push({
      pluginId: "thrower",
      pluginName: "Thrower",
      rawHandler: () => {
        throw new Error("blocked");
      },
      handler: () => {
        throw new Error("blocked");
      },
      runtimes: ["pi"],
      priority: 10,
      source: "test",
    });
    initializeGlobalHookRunner(registry);

    await expect(
      executeToolWithAgentToolCallMiddlewares({
        toolName: "demo",
        params: {},
        execute: baseExecute,
      }),
    ).rejects.toThrow("blocked");
    expect(baseExecute).not.toHaveBeenCalled();
  });
});
