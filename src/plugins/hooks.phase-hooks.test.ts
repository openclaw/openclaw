import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner, MAX_HOOK_CONTEXT_LENGTH } from "./hooks.js";
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

  it("truncates prependContext that exceeds MAX_HOOK_CONTEXT_LENGTH", async () => {
    const oversized = "x".repeat(MAX_HOOK_CONTEXT_LENGTH + 500);
    addTypedHook(
      registry,
      "before_prompt_build",
      "big",
      () => ({ prependContext: oversized }),
      10,
    );

    const warn = vi.fn();
    const runner = createHookRunner(registry, { logger: { warn, error: vi.fn() } });
    const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});

    expect(result?.prependContext?.length).toBeLessThan(oversized.length);
    expect(result?.prependContext).toContain("[…truncated by openclaw]");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("prependContext"));
  });

  it("truncates systemPrompt that exceeds MAX_HOOK_CONTEXT_LENGTH", async () => {
    const oversized = "s".repeat(MAX_HOOK_CONTEXT_LENGTH + 100);
    addTypedHook(
      registry,
      "before_prompt_build",
      "big",
      () => ({ systemPrompt: oversized }),
      10,
    );

    const warn = vi.fn();
    const runner = createHookRunner(registry, { logger: { warn, error: vi.fn() } });
    const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});

    expect(result?.systemPrompt?.length).toBeLessThan(oversized.length);
    expect(result?.systemPrompt).toContain("[…truncated by openclaw]");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("systemPrompt"));
  });

  it("does not truncate context within the length limit", async () => {
    const normalContext = "a".repeat(1000);
    addTypedHook(
      registry,
      "before_prompt_build",
      "normal",
      () => ({ prependContext: normalContext }),
      10,
    );

    const warn = vi.fn();
    const runner = createHookRunner(registry, { logger: { warn, error: vi.fn() } });
    const result = await runner.runBeforePromptBuild({ prompt: "test", messages: [] }, {});

    expect(result?.prependContext).toBe(normalContext);
    expect(warn).not.toHaveBeenCalled();
  });
});
