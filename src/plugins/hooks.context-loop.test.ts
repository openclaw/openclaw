import type { AgentMessage } from "@mariozechner/pi-agent-core";
/**
 * Unit tests for agent loop observability hooks:
 * context_assembled, loop_iteration_start, loop_iteration_end.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookAgentContext,
  PluginHookContextAssembledEvent,
  PluginHookLoopIterationStartEvent,
  PluginHookLoopIterationEndEvent,
  PluginHookRegistration,
} from "./types.js";

function makeRegistry(hooks: PluginHookRegistration[]) {
  return { typedHooks: hooks } as unknown as PluginRegistry;
}

const agentCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
};

function fakeMsg(role: string, content: string): AgentMessage {
  return { role, content } as AgentMessage;
}

describe("context_assembled hook", () => {
  const baseEvent: PluginHookContextAssembledEvent = {
    systemPrompt: "You are helpful.",
    prompt: "Tell me a joke",
    messages: [fakeMsg("user", "hi")],
    messageCount: 1,
    iteration: 0,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "context_assembled", handler, source: "test" }]),
    );
    await runner.runContextAssembled(baseEvent, agentCtx);
    expect(handler).toHaveBeenCalledOnce();
    const [event, ctx] = handler.mock.calls[0];
    expect(event).toMatchObject({
      systemPrompt: "You are helpful.",
      messageCount: 1,
      iteration: 0,
    });
    expect(ctx).toBe(agentCtx);
  });

  it("runs all handlers in parallel and returns void", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "context_assembled", handler: h1, source: "test" },
        { pluginId: "p2", hookName: "context_assembled", handler: h2, source: "test" },
      ]),
    );
    const result = await runner.runContextAssembled(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(result).toBeUndefined();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runContextAssembled(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

describe("loop_iteration_start hook", () => {
  const baseEvent: PluginHookLoopIterationStartEvent = {
    iteration: 2,
    pendingToolResults: 3,
    messageCount: 10,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "loop_iteration_start", handler, source: "test" }]),
    );
    await runner.runLoopIterationStart(baseEvent, agentCtx);
    expect(handler).toHaveBeenCalledOnce();
    const [event] = handler.mock.calls[0];
    expect(event).toMatchObject({ iteration: 2, pendingToolResults: 3, messageCount: 10 });
  });

  it("runs in parallel", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "loop_iteration_start", handler: h1, source: "test" },
        { pluginId: "p2", hookName: "loop_iteration_start", handler: h2, source: "test" },
      ]),
    );
    await runner.runLoopIterationStart(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runLoopIterationStart(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});

describe("loop_iteration_end hook", () => {
  const baseEvent: PluginHookLoopIterationEndEvent = {
    iteration: 3,
    toolCallsMade: 2,
    newMessagesAdded: 4,
    willContinue: true,
  };

  it("fires handler with correct event shape", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([{ pluginId: "p1", hookName: "loop_iteration_end", handler, source: "test" }]),
    );
    await runner.runLoopIterationEnd(baseEvent, agentCtx);
    expect(handler).toHaveBeenCalledOnce();
    const [event] = handler.mock.calls[0];
    expect(event).toMatchObject({
      iteration: 3,
      toolCallsMade: 2,
      newMessagesAdded: 4,
      willContinue: true,
    });
  });

  it("runs in parallel", async () => {
    const h1 = vi.fn().mockResolvedValue(undefined);
    const h2 = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "loop_iteration_end", handler: h1, source: "test" },
        { pluginId: "p2", hookName: "loop_iteration_end", handler: h2, source: "test" },
      ]),
    );
    await runner.runLoopIterationEnd(baseEvent, agentCtx);
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("skips when no handlers registered", async () => {
    const runner = createHookRunner(makeRegistry([]));
    const result = await runner.runLoopIterationEnd(baseEvent, agentCtx);
    expect(result).toBeUndefined();
  });
});
