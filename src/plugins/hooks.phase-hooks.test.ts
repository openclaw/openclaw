import { beforeEach, describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";

function addTypedHook(
  registry: PluginRegistry,
  hookName: "before_model_resolve" | "before_prompt_build",
  pluginId: string,
  handler: () =>
    | PluginHookBeforeModelResolveResult
    | PluginHookBeforePromptBuildResult
    | Promise<PluginHookBeforeModelResolveResult | PluginHookBeforePromptBuildResult>,
  priority?: number,
) {
  registry.typedHooks.push({
    pluginId,
    hookName,
    handler,
    priority,
    source: "test",
  } as PluginHookRegistration);
}

describe("phase hooks merger", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("before_model_resolve keeps higher-priority override values", async () => {
    addTypedHook(registry, "before_model_resolve", "low", () => ({ modelOverride: "gpt-4o" }), 1);
    addTypedHook(
      registry,
      "before_model_resolve",
      "high",
      () => ({ modelOverride: "llama3.3:8b", providerOverride: "ollama" }),
      10,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforeModelResolve({ prompt: "test" }, {});

    expect(result?.modelOverride).toBe("llama3.3:8b");
    expect(result?.providerOverride).toBe("ollama");
  });

  it("before_prompt_build concatenates prependContext and preserves systemPrompt precedence", async () => {
    addTypedHook(
      registry,
      "before_prompt_build",
      "high",
      () => ({ prependContext: "context A", systemPrompt: "system A" }),
      10,
    );
    addTypedHook(
      registry,
      "before_prompt_build",
      "low",
      () => ({ prependContext: "context B" }),
      1,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});

    expect(result?.prependContext).toBe("context A\n\ncontext B");
    expect(result?.systemPrompt).toBe("system A");
  });

  it("before_prompt_build skips prependContext when same as appendSystemPrompt (fallback pattern)", async () => {
    // Handler returns both with same content — fallback pattern
    // Should use appendSystemPrompt, skip prependContext
    addTypedHook(
      registry,
      "before_prompt_build",
      "plugin",
      () => ({
        appendSystemPrompt: "memory context here",
        prependContext: "memory context here", // same content = fallback
      }),
      10,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});

    expect(result?.appendSystemPrompt).toBe("memory context here");
    expect(result?.prependContext).toBeUndefined();
  });

  it("before_prompt_build uses both when appendSystemPrompt differs from prependContext", async () => {
    // Handler returns both with different content — legitimate dual use
    addTypedHook(
      registry,
      "before_prompt_build",
      "plugin",
      () => ({
        appendSystemPrompt: "instructions for the model",
        prependContext: "context for user prompt",
      }),
      10,
    );

    const runner = createHookRunner(registry);
    const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});

    expect(result?.appendSystemPrompt).toBe("instructions for the model");
    expect(result?.prependContext).toBe("context for user prompt");
  });
});
