/**
 * Tests for llm_input/llm_output modifying hook semantics.
 *
 * Validates the mutation contract, priority merge policy, event evolution,
 * backward compatibility (void returns), and security boundary enforcement.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addTestHook, TEST_PLUGIN_AGENT_CTX } from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type {
  PluginHookLlmInputEvent,
  PluginHookLlmInputResult,
  PluginHookLlmOutputEvent,
  PluginHookLlmOutputResult,
  PluginHookRegistration,
} from "./types.js";

const stubCtx = TEST_PLUGIN_AGENT_CTX;

function makeLlmInputEvent(overrides?: Partial<PluginHookLlmInputEvent>): PluginHookLlmInputEvent {
  return {
    runId: "run-1",
    sessionId: "session-1",
    provider: "openai",
    model: "gpt-5.5",
    systemPrompt: "be helpful",
    prompt: "hello world",
    historyMessages: [],
    imagesCount: 2,
    tools: [],
    ...overrides,
  };
}

function makeLlmOutputEvent(
  overrides?: Partial<PluginHookLlmOutputEvent>,
): PluginHookLlmOutputEvent {
  return {
    runId: "run-1",
    sessionId: "session-1",
    provider: "openai",
    model: "gpt-5.5",
    assistantTexts: ["Hello! How can I help?"],
    lastAssistant: { role: "assistant", content: "Hello! How can I help?" },
    usage: { input: 10, output: 20, total: 30 },
    ...overrides,
  };
}

function addLlmInputHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookLlmInputEvent,
  ) => PluginHookLlmInputResult | void | Promise<PluginHookLlmInputResult | void>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "llm_input",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

function addLlmOutputHook(
  registry: PluginRegistry,
  pluginId: string,
  handler: (
    event: PluginHookLlmOutputEvent,
  ) => PluginHookLlmOutputResult | void | Promise<PluginHookLlmOutputResult | void>,
  priority?: number,
) {
  addTestHook({
    registry,
    pluginId,
    hookName: "llm_output",
    handler: handler as PluginHookRegistration["handler"],
    priority,
  });
}

describe("llm_input modifying hook", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result).toBeUndefined();
  });

  it("returns undefined when handler returns void (backward compat)", async () => {
    addLlmInputHook(registry, "observer", () => {});
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result).toBeUndefined();
  });

  it("returns block result", async () => {
    addLlmInputHook(registry, "blocker", () => ({
      block: true,
      blockReason: "policy violation",
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result?.block).toBe(true);
    expect(result?.blockReason).toBe("policy violation");
  });

  it("returns prompt override", async () => {
    addLlmInputHook(registry, "rewriter", () => ({
      prompt: "rewritten prompt",
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result?.prompt).toBe("rewritten prompt");
  });

  it("returns systemPrompt override", async () => {
    addLlmInputHook(registry, "sys-rewriter", () => ({
      systemPrompt: "new system prompt",
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result?.systemPrompt).toBe("new system prompt");
  });

  it("first-setter-wins for prompt across priority-ordered handlers", async () => {
    addLlmInputHook(registry, "high-prio", () => ({ prompt: "high priority" }), 10);
    addLlmInputHook(registry, "low-prio", () => ({ prompt: "low priority" }), 0);
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result?.prompt).toBe("high priority");
  });

  it("block is sticky-true (later handler cannot unblock)", async () => {
    addLlmInputHook(registry, "blocker", () => ({ block: true, blockReason: "blocked" }), 10);
    addLlmInputHook(registry, "unblocker", () => ({ block: false }), 0);
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    // shouldStop fires on block=true, so the second handler never runs
    expect(result?.block).toBe(true);
  });

  it("evolves event so later handlers see prior prompt modifications", async () => {
    const secondHandlerSpy = vi.fn<[PluginHookLlmInputEvent], void>();
    addLlmInputHook(registry, "rewriter", () => ({ prompt: "rewritten" }), 10);
    addLlmInputHook(
      registry,
      "observer",
      (event) => {
        secondHandlerSpy(event);
      },
      0,
    );
    const runner = createHookRunner(registry);
    await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(secondHandlerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "rewritten", imagesCount: 0 }),
    );
  });

  it("resets imagesCount to 0 when prompt changes via evolveEvent", async () => {
    const spy = vi.fn<[PluginHookLlmInputEvent], void>();
    addLlmInputHook(registry, "rewriter", () => ({ prompt: "new" }), 10);
    addLlmInputHook(
      registry,
      "checker",
      (event) => {
        spy(event);
      },
      0,
    );
    const runner = createHookRunner(registry);
    await runner.runLlmInput(makeLlmInputEvent({ imagesCount: 5 }), stubCtx);
    expect(spy.mock.calls[0][0].imagesCount).toBe(0);
  });

  it("gracefully handles handler errors without breaking the chain", async () => {
    addLlmInputHook(
      registry,
      "crasher",
      () => {
        throw new Error("boom");
      },
      10,
    );
    addLlmInputHook(registry, "rewriter", () => ({ prompt: "still works" }), 0);
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result?.prompt).toBe("still works");
  });

  it("evolves from accumulated result, not raw handler result (A>B>C priority scenario)", async () => {
    // A(prio=20) sets prompt="A", B(prio=10) sets prompt="B", C(prio=0) observes.
    // First-setter-wins: merged result has prompt="A".
    // C should see prompt="A" (from accumulated result), NOT prompt="B" (from B's raw result).
    const cSpy = vi.fn<[PluginHookLlmInputEvent], void>();
    addLlmInputHook(registry, "plugin-A", () => ({ prompt: "A" }), 20);
    addLlmInputHook(registry, "plugin-B", () => ({ prompt: "B" }), 10);
    addLlmInputHook(
      registry,
      "plugin-C",
      (event) => {
        cSpy(event);
      },
      0,
    );
    const runner = createHookRunner(registry);
    const result = await runner.runLlmInput(makeLlmInputEvent(), stubCtx);
    expect(result?.prompt).toBe("A");
    // C must see the winning prompt "A", not the losing "B"
    expect(cSpy.mock.calls[0][0].prompt).toBe("A");
  });
});

describe("llm_output modifying hook", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = createEmptyPluginRegistry();
  });

  it("returns undefined when no hooks are registered", async () => {
    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(result).toBeUndefined();
  });

  it("returns undefined when handler returns void (backward compat)", async () => {
    addLlmOutputHook(registry, "observer", () => {});
    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(result).toBeUndefined();
  });

  it("returns assistantTexts override", async () => {
    addLlmOutputHook(registry, "redactor", () => ({
      assistantTexts: ["[REDACTED]"],
    }));
    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(result?.assistantTexts).toEqual(["[REDACTED]"]);
  });

  it("last-setter-wins for assistantTexts", async () => {
    addLlmOutputHook(registry, "first", () => ({ assistantTexts: ["first"] }), 10);
    addLlmOutputHook(registry, "second", () => ({ assistantTexts: ["second"] }), 0);
    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(result?.assistantTexts).toEqual(["second"]);
  });

  it("evolves event so later handlers see prior assistantTexts modifications", async () => {
    const spy = vi.fn<[PluginHookLlmOutputEvent], void>();
    addLlmOutputHook(registry, "redactor", () => ({ assistantTexts: ["redacted"] }), 10);
    addLlmOutputHook(
      registry,
      "observer",
      (event) => {
        spy(event);
      },
      0,
    );
    const runner = createHookRunner(registry);
    await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(spy.mock.calls[0][0].assistantTexts).toEqual(["redacted"]);
  });

  it("allows full suppression with empty array", async () => {
    addLlmOutputHook(registry, "suppressor", () => ({ assistantTexts: [] }));
    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(result?.assistantTexts).toEqual([]);
  });

  it("gracefully handles handler errors", async () => {
    addLlmOutputHook(
      registry,
      "crasher",
      () => {
        throw new Error("boom");
      },
      10,
    );
    addLlmOutputHook(registry, "redactor", () => ({ assistantTexts: ["safe"] }), 0);
    const runner = createHookRunner(registry);
    const result = await runner.runLlmOutput(makeLlmOutputEvent(), stubCtx);
    expect(result?.assistantTexts).toEqual(["safe"]);
  });
});
