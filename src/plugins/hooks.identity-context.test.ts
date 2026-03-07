/**
 * Tests for agent identity context enrichment.
 *
 * Verifies that PluginHookAgentContext includes sender identity fields
 * and that hooks receive them correctly.
 */
import { describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookAgentContext, PluginHookRegistration } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(hooks: PluginHookRegistration[]) {
  return { typedHooks: hooks } as unknown as PluginRegistry;
}

// ---------------------------------------------------------------------------
// Identity fields in PluginHookAgentContext
// ---------------------------------------------------------------------------

describe("PluginHookAgentContext identity fields", () => {
  const fullCtx: PluginHookAgentContext = {
    agentId: "main",
    sessionKey: "main:abc123",
    sessionId: "session-1",
    workspaceDir: "/home/test/.openclaw",
    messageProvider: "slack",
    sourceProvider: "slack",
    trigger: "user",
    channelId: "C123",
    senderId: "U456",
    senderName: "Eddie",
    senderIsOwner: true,
    groupId: "G789",
    spawnedBy: null,
  };

  it("passes identity fields to before_agent_start handlers", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_agent_start", handler, source: "test" },
      ] as PluginHookRegistration[]),
    );

    await runner.runBeforeAgentStart({ prompt: "hello" }, fullCtx);

    expect(handler).toHaveBeenCalledOnce();
    const [, ctx] = handler.mock.calls[0];
    expect(ctx.senderId).toBe("U456");
    expect(ctx.senderName).toBe("Eddie");
    expect(ctx.senderIsOwner).toBe(true);
    expect(ctx.sourceProvider).toBe("slack");
    expect(ctx.groupId).toBe("G789");
    expect(ctx.spawnedBy).toBeNull();
  });

  it("passes identity fields to before_tool_call handlers", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_tool_call", handler, source: "test" },
      ] as PluginHookRegistration[]),
    );

    await runner.runBeforeToolCall(
      { toolName: "exec", params: {}, runId: "run-1" },
      { ...fullCtx, toolName: "exec" },
    );

    const [, ctx] = handler.mock.calls[0];
    expect(ctx.senderId).toBe("U456");
    expect(ctx.senderName).toBe("Eddie");
    expect(ctx.senderIsOwner).toBe(true);
    expect(ctx.groupId).toBe("G789");
  });

  it("handles null identity fields for anonymous/system contexts", async () => {
    const anonymousCtx: PluginHookAgentContext = {
      agentId: "cron",
      sessionKey: "cron:heartbeat",
      trigger: "heartbeat",
      senderId: null,
      senderName: null,
      senderIsOwner: false,
      groupId: null,
      spawnedBy: null,
    };

    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "before_agent_start", handler, source: "test" },
      ] as PluginHookRegistration[]),
    );

    await runner.runBeforeAgentStart({ prompt: "heartbeat" }, anonymousCtx);

    const [, ctx] = handler.mock.calls[0];
    expect(ctx.senderId).toBeNull();
    expect(ctx.senderName).toBeNull();
    expect(ctx.senderIsOwner).toBe(false);
    expect(ctx.groupId).toBeNull();
  });

  it("passes sourceProvider separately from messageProvider", async () => {
    const ctx: PluginHookAgentContext = {
      agentId: "main",
      messageProvider: "webhook",
      sourceProvider: "discord",
      senderId: "123",
    };

    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "agent_end", handler, source: "test" },
      ] as PluginHookRegistration[]),
    );

    await runner.runAgentEnd({ messages: [], success: true, durationMs: 100 }, ctx);

    const [, receivedCtx] = handler.mock.calls[0];
    expect(receivedCtx.sourceProvider).toBe("discord");
    expect(receivedCtx.messageProvider).toBe("webhook");
  });

  it("includes sessionKey in message hook context", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const runner = createHookRunner(
      makeRegistry([
        { pluginId: "p1", hookName: "message_sending", handler, source: "test" },
      ] as PluginHookRegistration[]),
    );

    await runner.runMessageSending(
      { to: "user-1", content: "hello", metadata: {} },
      { channelId: "discord", sessionKey: "main:outbound-session" },
    );

    const [, ctx] = handler.mock.calls[0];
    expect(ctx.sessionKey).toBe("main:outbound-session");
    expect(ctx.channelId).toBe("discord");
  });
});
