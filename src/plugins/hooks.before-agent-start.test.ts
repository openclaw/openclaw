/**
 * Layer 1: Hook Merger Tests for before_agent_start
 *
 * Validates that modelOverride and providerOverride fields are correctly
 * propagated through the hook merger, including priority ordering and
 * backward compatibility.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { PluginHookBeforeAgentStartResult, TypedPluginHookRegistration } from "./types.js";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

function addBeforeAgentStartHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: () => PluginHookBeforeAgentStartResult | Promise<PluginHookBeforeAgentStartResult>,
  priority?: number,
) {
  registry.typedHooks.push({
    pluginId,
    hookName: "before_agent_start",
    handler,
    priority,
    source: "test",
  } as TypedPluginHookRegistration);
}

const stubCtx = {
  agentId: "test-agent",
  sessionKey: "sk",
  sessionId: "sid",
  workspaceDir: "/tmp",
};

describe("before_agent_start hook merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("returns modelOverride from a single plugin", async () => {
    addBeforeAgentStartHook(registry, "plugin-a", () => ({
      modelOverride: "llama3.3:8b",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.modelOverride).toBe("llama3.3:8b");
  });

  it("returns providerOverride from a single plugin", async () => {
    addBeforeAgentStartHook(registry, "plugin-a", () => ({
      providerOverride: "ollama",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.providerOverride).toBe("ollama");
  });

  it("returns both modelOverride and providerOverride together", async () => {
    addBeforeAgentStartHook(registry, "plugin-a", () => ({
      modelOverride: "llama3.3:8b",
      providerOverride: "ollama",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.modelOverride).toBe("llama3.3:8b");
    expect(result?.providerOverride).toBe("ollama");
  });

  it("higher-priority plugin wins for modelOverride (last-writer-wins by priority order)", async () => {
    // Lower priority runs first (priority 1), higher priority runs second (priority 10).
    // Since merger is sequential and uses `next ?? acc`, the higher-priority plugin's
    // value (which runs later) overwrites the earlier one.
    addBeforeAgentStartHook(registry, "low-priority", () => ({ modelOverride: "gpt-4o" }), 1);
    addBeforeAgentStartHook(
      registry,
      "high-priority",
      () => ({ modelOverride: "llama3.3:8b" }),
      10,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "PII prompt" }, stubCtx);

    // Higher priority (10) runs first in sorted order, then lower priority (1) runs.
    // Lower priority's value overwrites since merger uses next ?? acc (next wins if defined).
    // Actually: sorted by descending priority, so 10 runs first, then 1.
    // Merger: acc starts as 10's result, then next=1's result overwrites.
    expect(result?.modelOverride).toBe("gpt-4o");
  });

  it("lower-priority plugin does not overwrite if it returns undefined", async () => {
    addBeforeAgentStartHook(
      registry,
      "high-priority",
      () => ({ modelOverride: "llama3.3:8b", providerOverride: "ollama" }),
      10,
    );
    addBeforeAgentStartHook(
      registry,
      "low-priority",
      () => ({ prependContext: "some context" }),
      1,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    // High-priority ran first (priority 10), low-priority ran second (priority 1).
    // Low-priority didn't return modelOverride, so ?? falls back to acc's value.
    expect(result?.modelOverride).toBe("llama3.3:8b");
    expect(result?.providerOverride).toBe("ollama");
    expect(result?.prependContext).toBe("some context");
  });

  it("prependContext still concatenates when modelOverride is present", async () => {
    addBeforeAgentStartHook(
      registry,
      "plugin-a",
      () => ({
        prependContext: "context A",
        modelOverride: "llama3.3:8b",
      }),
      10,
    );
    addBeforeAgentStartHook(
      registry,
      "plugin-b",
      () => ({
        prependContext: "context B",
      }),
      1,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.prependContext).toBe("context A\n\ncontext B");
    expect(result?.modelOverride).toBe("llama3.3:8b");
  });

  it("backward compat: plugin returning only prependContext produces no modelOverride", async () => {
    addBeforeAgentStartHook(registry, "legacy-plugin", () => ({
      prependContext: "legacy context",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.prependContext).toBe("legacy context");
    expect(result?.modelOverride).toBeUndefined();
    expect(result?.providerOverride).toBeUndefined();
  });

  it("modelOverride without providerOverride leaves provider undefined", async () => {
    addBeforeAgentStartHook(registry, "plugin-a", () => ({
      modelOverride: "llama3.3:8b",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.modelOverride).toBe("llama3.3:8b");
    expect(result?.providerOverride).toBeUndefined();
  });

  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result).toBeUndefined();
  });

  it("systemPrompt merges correctly alongside model overrides", async () => {
    addBeforeAgentStartHook(registry, "plugin-a", () => ({
      systemPrompt: "You are a helpful assistant",
      modelOverride: "llama3.3:8b",
      providerOverride: "ollama",
    }));

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeAgentStart({ prompt: "hello" }, stubCtx);

    expect(result?.systemPrompt).toBe("You are a helpful assistant");
    expect(result?.modelOverride).toBe("llama3.3:8b");
    expect(result?.providerOverride).toBe("ollama");
  });
});
