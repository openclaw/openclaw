/**
 * Layer 2: Explicit model/prompt hook wiring tests.
 *
 * Verifies:
 * 1. before_model_resolve applies deterministic provider/model overrides
 * 2. before_prompt_build receives session messages and prepends prompt context
 * 3. before_agent_start remains a legacy compatibility fallback
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookAgentContext,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookBeforePromptBuildEvent,
  PluginHookBeforePromptBuildResult,
  PluginHookRegistration,
} from "./types.js";
import { joinPresentTextSegments } from "../shared/text/join-segments.js";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

function addBeforeModelResolveHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforeModelResolveResult | Promise<PluginHookBeforeModelResolveResult>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_model_resolve",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

function addBeforePromptBuildHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforePromptBuildEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforePromptBuildResult | Promise<PluginHookBeforePromptBuildResult>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "before_prompt_build",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

const stubCtx: PluginHookAgentContext = TEST_PLUGIN_AGENT_CTX;

describe("model override pipeline wiring", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  describe("before_model_resolve (run.ts pattern)", () => {
    it("hook receives prompt-only event and returns provider/model override", async () => {
      const handlerSpy = vi.fn(
        (_event: PluginHookBeforeModelResolveEvent) =>
          ({
            modelOverride: "llama3.3:8b",
            providerOverride: "ollama",
          }) as PluginHookBeforeModelResolveResult,
      );

      addBeforeModelResolveHook(registry, "router-plugin", handlerSpy);
      const runner = createHookRunner(registry);
      const result = await runner.runBeforeModelResolve({ prompt: "PII text" }, stubCtx);

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(handlerSpy).toHaveBeenCalledWith({ prompt: "PII text" }, stubCtx);
      expect(result?.modelOverride).toBe("llama3.3:8b");
      expect(result?.providerOverride).toBe("ollama");
    });

    it("new hook overrides beat legacy before_agent_start fallback", async () => {
      addBeforeModelResolveHook(registry, "new-hook", () => ({
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
      }));
      addTestHook({
        registry,
        pluginId: "legacy-hook",
        hookName: "before_agent_start",
        handler: (() => ({
          modelOverride: "gpt-4o",
          providerOverride: "openai",
        })) as PluginHookRegistration["handler"],
      });

      const runner = createHookRunner(registry);
      const explicit = await runner.runBeforeModelResolve({ prompt: "sensitive" }, stubCtx);
      const legacy = await runner.runBeforeAgentStart({ prompt: "sensitive" }, stubCtx);
      const merged = {
        providerOverride: explicit?.providerOverride ?? legacy?.providerOverride,
        modelOverride: explicit?.modelOverride ?? legacy?.modelOverride,
      };

      expect(merged.providerOverride).toBe("ollama");
      expect(merged.modelOverride).toBe("llama3.3:8b");
    });
  });

  describe("before_prompt_build (attempt.ts pattern)", () => {
    it("hook receives prompt and messages and can prepend context", async () => {
      const handlerSpy = vi.fn(
        (event: PluginHookBeforePromptBuildEvent) =>
          ({
            prependContext: `Saw ${event.messages.length} messages`,
          }) as PluginHookBeforePromptBuildResult,
      );

      addBeforePromptBuildHook(registry, "context-plugin", handlerSpy);
      const runner = createHookRunner(registry);
      const result = await runner.runBeforePromptBuild(
        { prompt: "test", messages: [{}, {}] as unknown[] },
        stubCtx,
      );

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(result?.prependContext).toBe("Saw 2 messages");
    });

    it("legacy before_agent_start context can still be merged as fallback", async () => {
      addBeforePromptBuildHook(registry, "new-hook", () => ({
        prependContext: "new context",
      }));
      addTestHook({
        registry,
        pluginId: "legacy-hook",
        hookName: "before_agent_start",
        handler: (() => ({
          prependContext: "legacy context",
        })) as PluginHookRegistration["handler"],
      });

      const runner = createHookRunner(registry);
      const promptBuild = await runner.runBeforePromptBuild(
        { prompt: "test", messages: [{ role: "user", content: "x" }] as unknown[] },
        stubCtx,
      );
      const legacy = await runner.runBeforeAgentStart(
        { prompt: "test", messages: [{ role: "user", content: "x" }] as unknown[] },
        stubCtx,
      );
      const prependContext = joinPresentTextSegments([
        promptBuild?.prependContext,
        legacy?.prependContext,
      ]);

      expect(prependContext).toBe("new context\n\nlegacy context");
    });
  });

  describe("graceful degradation + hook detection", () => {
    it("one broken before_model_resolve plugin does not block other overrides", async () => {
      addBeforeModelResolveHook(
        registry,
        "broken-plugin",
        () => {
          throw new Error("plugin crashed");
        },
        10,
      );
      addBeforeModelResolveHook(
        registry,
        "router-plugin",
        () => ({
          modelOverride: "llama3.3:8b",
          providerOverride: "ollama",
        }),
        1,
      );

      const runner = createHookRunner(registry, { catchErrors: true });
      const result = await runner.runBeforeModelResolve({ prompt: "PII data" }, stubCtx);

      expect(result?.modelOverride).toBe("llama3.3:8b");
      expect(result?.providerOverride).toBe("ollama");
    });

    it("hasHooks reports new and legacy hooks independently", () => {
      const runner1 = createHookRunner(registry);
      expect(runner1.hasHooks("before_model_resolve")).toBe(false);
      expect(runner1.hasHooks("before_prompt_build")).toBe(false);
      expect(runner1.hasHooks("before_agent_start")).toBe(false);

      addBeforeModelResolveHook(registry, "plugin-a", () => ({}));
      addBeforePromptBuildHook(registry, "plugin-b", () => ({}));
      addTestHook({
        registry,
        pluginId: "plugin-c",
        hookName: "before_agent_start",
        handler: (() => ({})) as PluginHookRegistration["handler"],
      });

      const runner2 = createHookRunner(registry);
      expect(runner2.hasHooks("before_model_resolve")).toBe(true);
      expect(runner2.hasHooks("before_prompt_build")).toBe(true);
      expect(runner2.hasHooks("before_agent_start")).toBe(true);
    });
  });
});
