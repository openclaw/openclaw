import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import {
  addStaticTestHooks,
  addTestHook,
  createHookRunnerWithRegistry,
  createMockPluginRegistry,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-helpers.js";
import type { PluginHookLlmInputEvent, PluginHookLlmOutputEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseLlmInputEvent(overrides?: Partial<PluginHookLlmInputEvent>): PluginHookLlmInputEvent {
  return {
    runId: "run-1",
    sessionId: "session-1",
    provider: "openai",
    model: "gpt-5.4",
    systemPrompt: "be helpful",
    prompt: "hello world",
    historyMessages: [],
    imagesCount: 0,
    ...overrides,
  };
}

function baseLlmOutputEvent(
  overrides?: Partial<PluginHookLlmOutputEvent>,
): PluginHookLlmOutputEvent {
  return {
    runId: "run-1",
    sessionId: "session-1",
    provider: "openai",
    model: "gpt-5.4",
    assistantTexts: ["original response"],
    lastAssistant: { role: "assistant", content: "original response" },
    usage: { input: 10, output: 20, total: 30 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// llm_input — modifying behavior
// ---------------------------------------------------------------------------

describe("llm_input modifying hooks", () => {
  it("returns undefined when no hooks are registered", async () => {
    const { runner } = createHookRunnerWithRegistry([]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toBeUndefined();
  });

  it("returns undefined when handler returns void", async () => {
    const { runner } = createHookRunnerWithRegistry([{ hookName: "llm_input", handler: vi.fn() }]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toBeUndefined();
  });

  it("returns block result when handler blocks", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "llm_input",
        handler: () => ({ block: true, blockReason: "policy violation" }),
      },
    ]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toEqual(
      expect.objectContaining({ block: true, blockReason: "policy violation" }),
    );
  });

  it("returns prompt override when handler rewrites prompt", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "llm_input",
        handler: () => ({ prompt: "rewritten prompt" }),
      },
    ]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result?.prompt).toBe("rewritten prompt");
  });

  it("returns systemPrompt override when handler rewrites system prompt", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "llm_input",
        handler: () => ({ systemPrompt: "new system prompt" }),
      },
    ]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result?.systemPrompt).toBe("new system prompt");
  });

  it("allows empty string prompt override", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "llm_input",
        handler: () => ({ prompt: "" }),
      },
    ]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result?.prompt).toBe("");
  });

  it("stops executing handlers after a block", async () => {
    const secondHandler = vi.fn();
    const registry = createMockPluginRegistry([]);
    addStaticTestHooks(registry, {
      hookName: "llm_input",
      hooks: [
        { pluginId: "blocker", result: { block: true, blockReason: "blocked" }, priority: 10 },
        { pluginId: "rewriter", result: { prompt: "should not run" }, priority: 0 },
      ],
    });
    addTestHook({
      registry,
      pluginId: "observer",
      hookName: "llm_input",
      handler: secondHandler,
      priority: 0,
    });

    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);

    expect(result?.block).toBe(true);
    // The second handler should not be called because block stops execution
    expect(secondHandler).not.toHaveBeenCalled();
  });

  describe("multi-plugin priority and merge", () => {
    it("higher-priority prompt override wins (first setter wins)", async () => {
      const registry = createMockPluginRegistry([]);
      addStaticTestHooks(registry, {
        hookName: "llm_input",
        hooks: [
          { pluginId: "high-pri", result: { prompt: "high priority prompt" }, priority: 10 },
          { pluginId: "low-pri", result: { prompt: "low priority prompt" }, priority: 0 },
        ],
      });

      const runner = createHookRunner(registry);
      const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);

      expect(result?.prompt).toBe("high priority prompt");
    });

    it("lower-priority handler can set systemPrompt when higher-priority only set prompt", async () => {
      const registry = createMockPluginRegistry([]);
      addStaticTestHooks(registry, {
        hookName: "llm_input",
        hooks: [
          { pluginId: "prompt-setter", result: { prompt: "new prompt" }, priority: 10 },
          {
            pluginId: "system-setter",
            result: { systemPrompt: "new system" },
            priority: 0,
          },
        ],
      });

      const runner = createHookRunner(registry);
      const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);

      expect(result?.prompt).toBe("new prompt");
      expect(result?.systemPrompt).toBe("new system");
    });

    it("evolveEvent propagates prompt override to lower-priority handlers", async () => {
      const lowPriHandler = vi.fn();
      const registry = createMockPluginRegistry([]);
      addStaticTestHooks(registry, {
        hookName: "llm_input",
        hooks: [{ pluginId: "rewriter", result: { prompt: "rewritten" }, priority: 10 }],
      });
      addTestHook({
        registry,
        pluginId: "observer",
        hookName: "llm_input",
        handler: lowPriHandler,
        priority: 0,
      });

      const runner = createHookRunner(registry);
      await runner.runLlmInput(baseLlmInputEvent({ prompt: "original" }), TEST_PLUGIN_AGENT_CTX);

      // The observer should see the evolved event with the rewritten prompt
      expect(lowPriHandler).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "rewritten" }),
        expect.anything(),
      );
    });

    it("block from any handler propagates even if other handlers set prompt", async () => {
      const registry = createMockPluginRegistry([]);
      addStaticTestHooks(registry, {
        hookName: "llm_input",
        hooks: [
          {
            pluginId: "blocker",
            result: { block: true, blockReason: "forbidden" },
            priority: 10,
          },
        ],
      });

      const runner = createHookRunner(registry);
      const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);

      expect(result?.block).toBe(true);
      expect(result?.blockReason).toBe("forbidden");
    });
  });
});

// ---------------------------------------------------------------------------
// llm_output — modifying behavior
// ---------------------------------------------------------------------------

describe("llm_output modifying hooks", () => {
  it("returns undefined when no hooks are registered", async () => {
    const { runner } = createHookRunnerWithRegistry([]);
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toBeUndefined();
  });

  it("returns undefined when handler returns void", async () => {
    const { runner } = createHookRunnerWithRegistry([{ hookName: "llm_output", handler: vi.fn() }]);
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toBeUndefined();
  });

  it("returns assistantTexts override when handler redacts", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "llm_output",
        handler: () => ({ assistantTexts: ["[REDACTED]"] }),
      },
    ]);
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result?.assistantTexts).toEqual(["[REDACTED]"]);
  });

  it("allows full suppression with empty array", async () => {
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "llm_output",
        handler: () => ({ assistantTexts: [] }),
      },
    ]);
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result?.assistantTexts).toEqual([]);
  });

  it("evolveEvent propagates redaction to later hooks", async () => {
    const secondHandler = vi.fn();
    const registry = createMockPluginRegistry([]);
    addStaticTestHooks(registry, {
      hookName: "llm_output",
      hooks: [{ pluginId: "redactor", result: { assistantTexts: ["[REDACTED]"] }, priority: 10 }],
    });
    addTestHook({
      registry,
      pluginId: "observer",
      hookName: "llm_output",
      handler: secondHandler,
      priority: 0,
    });

    const runner = createHookRunner(registry);
    await runner.runLlmOutput(
      baseLlmOutputEvent({ assistantTexts: ["secret info"] }),
      TEST_PLUGIN_AGENT_CTX,
    );

    // The observer should see the redacted texts, not the original
    expect(secondHandler).toHaveBeenCalledWith(
      expect.objectContaining({ assistantTexts: ["[REDACTED]"] }),
      expect.anything(),
    );
  });

  it("later handler override wins for assistantTexts (last writer wins)", async () => {
    const registry = createMockPluginRegistry([]);
    addStaticTestHooks(registry, {
      hookName: "llm_output",
      hooks: [
        {
          pluginId: "first-redactor",
          result: { assistantTexts: ["first redaction"] },
          priority: 10,
        },
        {
          pluginId: "second-redactor",
          result: { assistantTexts: ["second redaction"] },
          priority: 0,
        },
      ],
    });

    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);

    // For llm_output, `next.assistantTexts ?? acc.assistantTexts` means last writer wins
    expect(result?.assistantTexts).toEqual(["second redaction"]);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — void returns
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  it("llm_input void handler does not alter the result", async () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "llm_input", handler: () => undefined },
    ]);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toBeUndefined();
  });

  it("llm_output void handler does not alter the result", async () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "llm_output", handler: () => undefined },
    ]);
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);
    expect(result).toBeUndefined();
  });

  it("mix of void and modifying handlers — only modifying result is returned", async () => {
    const registry = createMockPluginRegistry([]);
    addStaticTestHooks(registry, {
      hookName: "llm_input",
      hooks: [
        {
          pluginId: "observer",
          result: undefined as never,
          handler: () => undefined,
          priority: 10,
        },
        { pluginId: "rewriter", result: { prompt: "modified" }, priority: 0 },
      ],
    });

    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);

    expect(result?.prompt).toBe("modified");
  });
});

// ---------------------------------------------------------------------------
// Error handling — graceful degradation
// ---------------------------------------------------------------------------

describe("hook error handling", () => {
  it("llm_input handler error is caught and later handlers still run", async () => {
    const successHandler = vi.fn(() => ({ prompt: "fallback prompt" }));
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "broken",
      hookName: "llm_input",
      handler: () => {
        throw new Error("plugin crash");
      },
      priority: 10,
    });
    addTestHook({
      registry,
      pluginId: "working",
      hookName: "llm_input",
      handler: successHandler,
      priority: 0,
    });

    const runner = createHookRunner(registry, { catchErrors: true });
    const result = await runner.runLlmInput(baseLlmInputEvent(), TEST_PLUGIN_AGENT_CTX);

    expect(successHandler).toHaveBeenCalled();
    expect(result?.prompt).toBe("fallback prompt");
  });

  it("llm_output handler error is caught and later handlers still run", async () => {
    const successHandler = vi.fn(() => ({ assistantTexts: ["safe text"] }));
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "broken",
      hookName: "llm_output",
      handler: () => {
        throw new Error("plugin crash");
      },
      priority: 10,
    });
    addTestHook({
      registry,
      pluginId: "working",
      hookName: "llm_output",
      handler: successHandler,
      priority: 0,
    });

    const runner = createHookRunner(registry, { catchErrors: true });
    const result = await runner.runLlmOutput(baseLlmOutputEvent(), TEST_PLUGIN_AGENT_CTX);

    expect(successHandler).toHaveBeenCalled();
    expect(result?.assistantTexts).toEqual(["safe text"]);
  });
});
