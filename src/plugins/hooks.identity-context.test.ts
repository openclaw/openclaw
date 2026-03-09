/**
 * Tests for agent identity context enrichment.
 *
 * Verifies that PluginHookAgentContext includes sender identity fields
 * and that hooks receive them correctly — both via static fixtures (unit)
 * and via the actual hookCtx construction pattern used in attempt.ts (integration).
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

  // ---------------------------------------------------------------------------
  // Integration: hookCtx construction matching attempt.ts pattern
  // ---------------------------------------------------------------------------
  // These tests replicate the actual hookCtx object literal from attempt.ts
  // (lines ~1628-1642) to verify the params → hookCtx mapping preserves
  // identity fields end-to-end, including null coercion semantics.

  describe("hookCtx construction (attempt.ts pattern)", () => {
    // Replicates the exact construction from attempt.ts:
    // const hookCtx = { agentId, sessionKey, ..., senderId: params.senderId ?? null, ... }
    function buildHookCtx(params: Record<string, unknown>): PluginHookAgentContext {
      return {
        agentId: params.agentId as string,
        sessionKey: params.sessionKey as string,
        sessionId: params.sessionId as string,
        workspaceDir: params.workspaceDir as string,
        messageProvider: (params.messageProvider as string) ?? undefined,
        sourceProvider: (params.sourceProvider as string) ?? undefined,
        trigger: params.trigger as string,
        channelId:
          (params.messageChannel as string) ?? (params.messageProvider as string) ?? undefined,
        senderId: (params.senderId as string) ?? null,
        senderName: (params.senderName as string) ?? null,
        senderIsOwner: params.senderIsOwner as boolean,
        groupId: (params.groupId as string) ?? null,
        spawnedBy: (params.spawnedBy as string) ?? null,
      };
    }

    it("maps fully-populated params to hookCtx with all identity fields", () => {
      const ctx = buildHookCtx({
        agentId: "main",
        sessionKey: "agent:main:abc",
        sessionId: "sess-1",
        workspaceDir: "/home/user/.openclaw",
        messageProvider: "slack",
        sourceProvider: "telegram",
        trigger: "user",
        messageChannel: "C123",
        senderId: "U456",
        senderName: "Eddie",
        senderIsOwner: true,
        groupId: "G789",
        spawnedBy: null,
      });

      expect(ctx.sourceProvider).toBe("telegram");
      expect(ctx.messageProvider).toBe("slack");
      expect(ctx.senderId).toBe("U456");
      expect(ctx.senderName).toBe("Eddie");
      expect(ctx.senderIsOwner).toBe(true);
      expect(ctx.groupId).toBe("G789");
      expect(ctx.spawnedBy).toBeNull();
      expect(ctx.channelId).toBe("C123");
    });

    it("coerces undefined identity fields to null (not undefined)", () => {
      const ctx = buildHookCtx({
        agentId: "cron",
        sessionKey: "cron:heartbeat",
        trigger: "heartbeat",
        // All identity fields omitted (undefined in params)
      });

      expect(ctx.senderId).toBeNull();
      expect(ctx.senderName).toBeNull();
      expect(ctx.groupId).toBeNull();
      expect(ctx.spawnedBy).toBeNull();
      expect(ctx.sourceProvider).toBeUndefined();
      expect(ctx.messageProvider).toBeUndefined();
    });

    it("preserves null spawnedBy (not converted to undefined)", () => {
      const ctx = buildHookCtx({
        agentId: "main",
        sessionKey: "main:abc",
        trigger: "user",
        spawnedBy: null,
      });

      // null means "explicitly not spawned" — distinct from undefined ("unknown")
      expect(ctx.spawnedBy).toBeNull();
      expect(ctx.spawnedBy).not.toBeUndefined();
    });

    it("falls back channelId to messageProvider when messageChannel is absent", () => {
      const ctx = buildHookCtx({
        agentId: "main",
        sessionKey: "main:abc",
        trigger: "user",
        messageProvider: "discord",
        // messageChannel omitted
      });

      expect(ctx.channelId).toBe("discord");
    });
  });
});
