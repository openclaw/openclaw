/**
 * Layer 2: Model Override Pipeline Wiring Tests
 *
 * Tests the integration between the hook runner and model override flow.
 * Verifies that:
 * 1. When hooks return modelOverride/providerOverride, the run pipeline applies them
 * 2. The earlyHookResult mechanism prevents double-firing of before_agent_start
 * 3. Graceful degradation when hooks throw errors
 *
 * These tests verify the hook runner contract at the boundary — the same runner
 * that's used by both run.ts (early invocation) and attempt.ts (fallback invocation).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentContext,
  TypedPluginHookRegistration,
} from "./types.js";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";

function addBeforeAgentStartHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext,
  ) => PluginHookBeforeAgentStartResult | Promise<PluginHookBeforeAgentStartResult>,
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

const stubCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "sk",
  sessionId: "sid",
  workspaceDir: "/tmp",
};

describe("model override pipeline wiring", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  describe("early invocation (run.ts pattern)", () => {
    it("hook receives prompt-only event and returns model override", async () => {
      const handlerSpy = vi.fn(
        (_event: PluginHookBeforeAgentStartEvent) =>
          ({
            modelOverride: "llama3.3:8b",
            providerOverride: "ollama",
            prependContext: "PII detected: routing to local model",
          }) as PluginHookBeforeAgentStartResult,
      );

      addBeforeAgentStartHook(registry, "router-plugin", handlerSpy);
      const runner = createHookRunner(registry);

      // Simulate run.ts early invocation: prompt only, no messages
      const result = await runner.runBeforeAgentStart({ prompt: "My SSN is 123-45-6789" }, stubCtx);

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(handlerSpy).toHaveBeenCalledWith({ prompt: "My SSN is 123-45-6789" }, stubCtx);
      expect(result?.modelOverride).toBe("llama3.3:8b");
      expect(result?.providerOverride).toBe("ollama");
      expect(result?.prependContext).toBe("PII detected: routing to local model");
    });

    it("overrides can be applied to mutable provider/model variables", async () => {
      addBeforeAgentStartHook(registry, "router-plugin", () => ({
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
      }));

      const runner = createHookRunner(registry);
      const result = await runner.runBeforeAgentStart({ prompt: "sensitive data" }, stubCtx);

      // Simulate run.ts override application
      let provider = "anthropic";
      let modelId = "claude-sonnet-4-5-20250929";

      if (result?.providerOverride) {
        provider = result.providerOverride;
      }
      if (result?.modelOverride) {
        modelId = result.modelOverride;
      }

      expect(provider).toBe("ollama");
      expect(modelId).toBe("llama3.3:8b");
    });

    it("no overrides when hook returns only prependContext", async () => {
      addBeforeAgentStartHook(registry, "context-plugin", () => ({
        prependContext: "Additional instructions",
      }));

      const runner = createHookRunner(registry);
      const result = await runner.runBeforeAgentStart({ prompt: "normal query" }, stubCtx);

      // Simulate run.ts override application
      let provider = "anthropic";
      let modelId = "claude-sonnet-4-5-20250929";

      if (result?.providerOverride) {
        provider = result.providerOverride;
      }
      if (result?.modelOverride) {
        modelId = result.modelOverride;
      }

      // Original values preserved
      expect(provider).toBe("anthropic");
      expect(modelId).toBe("claude-sonnet-4-5-20250929");
    });
  });

  describe("earlyHookResult passthrough (attempt.ts pattern)", () => {
    it("when earlyHookResult exists, hook does not need to fire again", async () => {
      const handlerSpy = vi.fn(() => ({
        modelOverride: "should-not-be-called",
      }));

      addBeforeAgentStartHook(registry, "router-plugin", handlerSpy);
      const runner = createHookRunner(registry);

      // Simulate the earlyHookResult already computed by run.ts
      const earlyHookResult: PluginHookBeforeAgentStartResult = {
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
        prependContext: "PII detected",
      };

      // Simulate attempt.ts pattern: use earlyHookResult if present
      const hookResult =
        earlyHookResult ??
        (runner.hasHooks("before_agent_start")
          ? await runner.runBeforeAgentStart({ prompt: "test", messages: [] }, stubCtx)
          : undefined);

      expect(handlerSpy).not.toHaveBeenCalled();
      expect(hookResult?.modelOverride).toBe("llama3.3:8b");
      expect(hookResult?.prependContext).toBe("PII detected");
    });

    it("when earlyHookResult is undefined, hook fires normally with messages", async () => {
      const handlerSpy = vi.fn(
        (event: PluginHookBeforeAgentStartEvent) =>
          ({
            prependContext: `Saw ${(event.messages ?? []).length} messages`,
          }) as PluginHookBeforeAgentStartResult,
      );

      addBeforeAgentStartHook(registry, "context-plugin", handlerSpy);
      const runner = createHookRunner(registry);

      const earlyHookResult: PluginHookBeforeAgentStartResult | undefined = undefined;

      // Simulate attempt.ts pattern: fire hook since no early result
      const hookResult =
        earlyHookResult ??
        (runner.hasHooks("before_agent_start")
          ? await runner.runBeforeAgentStart(
              { prompt: "test", messages: [{}, {}] as unknown[] },
              stubCtx,
            )
          : undefined);

      expect(handlerSpy).toHaveBeenCalledTimes(1);
      expect(hookResult?.prependContext).toBe("Saw 2 messages");
    });

    it("prependContext from earlyHookResult is applied to prompt", async () => {
      const earlyHookResult: PluginHookBeforeAgentStartResult = {
        prependContext: "PII detected: SSN found. Routing to local model.",
        modelOverride: "llama3.3:8b",
        providerOverride: "ollama",
      };

      // Simulate attempt.ts prompt modification
      const originalPrompt = "My SSN is 123-45-6789";
      let effectivePrompt = originalPrompt;
      if (earlyHookResult.prependContext) {
        effectivePrompt = `${earlyHookResult.prependContext}\n\n${originalPrompt}`;
      }

      expect(effectivePrompt).toBe(
        "PII detected: SSN found. Routing to local model.\n\nMy SSN is 123-45-6789",
      );
    });
  });

  describe("graceful degradation", () => {
    it("hook error does not produce override (run.ts pattern)", async () => {
      addBeforeAgentStartHook(registry, "broken-plugin", () => {
        throw new Error("plugin crashed");
      });

      const runner = createHookRunner(registry, { catchErrors: true });

      // The runner catches errors internally when catchErrors is true
      const result = await runner.runBeforeAgentStart({ prompt: "test" }, stubCtx);

      // Result should be undefined since the handler threw
      expect(result?.modelOverride).toBeUndefined();
      expect(result?.providerOverride).toBeUndefined();
    });

    it("one broken plugin does not prevent other plugins from providing overrides", async () => {
      addBeforeAgentStartHook(
        registry,
        "broken-plugin",
        () => {
          throw new Error("plugin crashed");
        },
        10, // Higher priority, runs first
      );
      addBeforeAgentStartHook(
        registry,
        "router-plugin",
        () => ({
          modelOverride: "llama3.3:8b",
          providerOverride: "ollama",
        }),
        1, // Lower priority, runs second
      );

      const runner = createHookRunner(registry, { catchErrors: true });
      const result = await runner.runBeforeAgentStart({ prompt: "PII data" }, stubCtx);

      // The router plugin's result should still be returned
      expect(result?.modelOverride).toBe("llama3.3:8b");
      expect(result?.providerOverride).toBe("ollama");
    });

    it("hasHooks correctly reports when before_agent_start hooks exist", () => {
      const runner1 = createHookRunner(registry);
      expect(runner1.hasHooks("before_agent_start")).toBe(false);

      addBeforeAgentStartHook(registry, "plugin-a", () => ({}));
      const runner2 = createHookRunner(registry);
      expect(runner2.hasHooks("before_agent_start")).toBe(true);
    });
  });
});
