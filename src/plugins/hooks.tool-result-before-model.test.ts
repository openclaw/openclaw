import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookRegistration,
  PluginHookToolResultBeforeModelContext,
  PluginHookToolResultBeforeModelEvent,
  PluginHookToolResultBeforeModelResult,
} from "./types.js";

const stubEvent: PluginHookToolResultBeforeModelEvent = {
  toolName: "read",
  toolCallId: "call_1",
  text: "original",
};

const stubCtx: PluginHookToolResultBeforeModelContext = {
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "session-1-id",
  runId: "run-1",
  toolName: "read",
  toolCallId: "call_1",
};

describe("tool_result_before_model hook", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  function addHook(params: {
    pluginId: string;
    priority?: number;
    handler: (
      event: PluginHookToolResultBeforeModelEvent,
      ctx: PluginHookToolResultBeforeModelContext,
    ) => PluginHookToolResultBeforeModelResult | void;
  }) {
    addTestHook({
      registry,
      pluginId: params.pluginId,
      hookName: "tool_result_before_model",
      handler: params.handler as PluginHookRegistration["handler"],
      priority: params.priority,
    });
  }

  it("replaces the canonical text for a single hook", () => {
    addHook({
      pluginId: "single",
      handler: () => ({ text: "replacement" }),
    });

    const runner = createHookRunner(registry);
    const result = runner.runToolResultBeforeModel(stubEvent, stubCtx);

    expect(result).toEqual({ text: "replacement" });
  });

  it("chains replacements across multiple hooks in priority order", () => {
    addHook({
      pluginId: "high",
      priority: 10,
      handler: (event) => ({ text: `${event.text} -> high` }),
    });
    addHook({
      pluginId: "low",
      priority: 5,
      handler: (event) => ({ text: `${event.text} -> low` }),
    });

    const runner = createHookRunner(registry);
    const result = runner.runToolResultBeforeModel(stubEvent, stubCtx);

    expect(result).toEqual({ text: "original -> high -> low" });
  });

  it("treats empty handler returns as no-op", () => {
    addHook({
      pluginId: "noop",
      handler: () => ({}),
    });

    const runner = createHookRunner(registry);
    const result = runner.runToolResultBeforeModel(stubEvent, stubCtx);

    expect(result).toEqual({ text: "original" });
  });

  it("ignores invalid non-string replacement values", () => {
    addHook({
      pluginId: "invalid",
      handler: () => ({ text: 123 as unknown as string }),
    });

    const runner = createHookRunner(registry);
    const result = runner.runToolResultBeforeModel(stubEvent, stubCtx);

    expect(result).toEqual({ text: "original" });
  });

  it("passes tool identity through unchanged", () => {
    const seen = vi.fn();
    addHook({
      pluginId: "inspect",
      handler: (event, ctx) => {
        seen(event, ctx);
        return undefined;
      },
    });

    const runner = createHookRunner(registry);
    const result = runner.runToolResultBeforeModel(stubEvent, stubCtx);

    expect(result).toEqual({ text: "original" });
    expect(seen).toHaveBeenCalledWith(stubEvent, stubCtx);
  });

  it("fails open when a handler throws", () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    addHook({
      pluginId: "boom",
      handler: () => {
        throw new Error("boom");
      },
    });

    const runner = createHookRunner(registry, { logger });
    const result = runner.runToolResultBeforeModel(stubEvent, stubCtx);

    expect(result).toEqual({ text: "original" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("tool_result_before_model handler from boom failed"),
    );
  });
});
