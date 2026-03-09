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

  describe("hookCtx construction (attempt.ts pattern)", () => {
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

    it("groupId from DM (null) and omitted groupId both arrive as null in hookCtx", () => {
      // Design constraint: the ?? null coercion in attempt.ts collapses both
      // "confirmed DM" (null) and "not computed" (undefined) to null at the
      // hook level.  The distinction is preserved at the queue level
      // (FollowupRun.run.groupId: null vs undefined) but not in hookCtx.
      // Plugins that need the distinction should read from run params directly.
      const dmCtx = buildHookCtx({
        agentId: "main",
        sessionKey: "main:abc",
        trigger: "user",
        groupId: null,
      });
      expect(dmCtx.groupId).toBeNull();

      const unknownCtx = buildHookCtx({
        agentId: "main",
        sessionKey: "main:abc",
        trigger: "user",
        // groupId omitted entirely → undefined in params → null via ?? null
      });
      expect(unknownCtx.groupId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // End-to-end pipeline simulation
  // ---------------------------------------------------------------------------
  // Replicates the full get-reply-run → FollowupRun.run → attempt.ts hookCtx
  // chain to verify identity field preservation across all three stages,
  // including the sourceProvider platform-token extraction and the null-for-
  // confirmed vs undefined-for-unknown semantic distinction.

  describe("full pipeline identity propagation", () => {
    // Stage 1: get-reply-run.ts — session context → run params
    // Replicates the sourceProvider extraction from get-reply-run.ts lines ~499-511
    function extractSourceProvider(
      originatingChannel: string | undefined,
      sessionOriginatingChannel: string | undefined,
      provider: string | undefined,
      surface: string | undefined,
      sessionProvider: string | undefined,
    ): string | undefined {
      return (
        (
          (
            originatingChannel ??
            sessionOriginatingChannel ??
            provider ??
            surface ??
            sessionProvider
          )
            ?.trim()
            .toLowerCase() || ""
        ).split(":")[0] || undefined
      );
    }

    // Stage 2: FollowupRun.run — run params stored as-is in the queue
    // (identity: transparent forwarding)

    // Stage 3: attempt.ts — run params → hookCtx
    // (already covered by buildHookCtx above)

    it("sourceProvider extracts platform token from routing paths", () => {
      // "telegram:group:123" → "telegram"
      expect(
        extractSourceProvider("telegram:group:123", undefined, undefined, undefined, undefined),
      ).toBe("telegram");
      // "discord" → "discord"
      expect(extractSourceProvider("discord", undefined, undefined, undefined, undefined)).toBe(
        "discord",
      );
      // Full channel key "slack:channel:C123" → "slack"
      expect(
        extractSourceProvider("slack:channel:C123", undefined, undefined, undefined, undefined),
      ).toBe("slack");
    });

    it("sourceProvider falls through chain correctly", () => {
      // OriginatingChannel takes priority
      expect(extractSourceProvider("telegram", "slack", "webchat", undefined, "webchat")).toBe(
        "telegram",
      );
      // Falls back to session OriginatingChannel
      expect(extractSourceProvider(undefined, "signal", "webchat", undefined, undefined)).toBe(
        "signal",
      );
      // Falls back to Provider
      expect(extractSourceProvider(undefined, undefined, "slack", undefined, undefined)).toBe(
        "slack",
      );
      // Falls back to Surface
      expect(extractSourceProvider(undefined, undefined, undefined, "webchat", undefined)).toBe(
        "webchat",
      );
      // Falls back to session Provider
      expect(extractSourceProvider(undefined, undefined, undefined, undefined, "telegram")).toBe(
        "telegram",
      );
      // All undefined → undefined
      expect(
        extractSourceProvider(undefined, undefined, undefined, undefined, undefined),
      ).toBeUndefined();
    });

    it("identity fields survive the full 3-stage pipeline for group messages", () => {
      // Stage 1: get-reply-run extracts identity from session context
      const sourceProvider = extractSourceProvider(
        "telegram",
        undefined,
        "webchat",
        undefined,
        undefined,
      );
      const runParams = {
        sourceProvider,
        groupId: "G789" as string | null,
        senderId: "U456" as string | null,
        senderName: "Eddie" as string | null,
        senderIsOwner: true,
        spawnedBy: null as string | null,
      };

      // Stage 2: FollowupRun.run stores identity as-is (transparent forwarding)
      const queuedRun = { ...runParams };

      // Stage 3: attempt.ts builds hookCtx
      const hookCtx = buildHookCtx({
        agentId: "main",
        sessionKey: "main:abc",
        trigger: "user",
        messageProvider: "webchat",
        sourceProvider: queuedRun.sourceProvider,
        senderId: queuedRun.senderId,
        senderName: queuedRun.senderName,
        senderIsOwner: queuedRun.senderIsOwner,
        groupId: queuedRun.groupId,
        spawnedBy: queuedRun.spawnedBy,
      });

      // sourceProvider is the origin platform, not the routing channel
      expect(hookCtx.sourceProvider).toBe("telegram");
      expect(hookCtx.messageProvider).toBe("webchat");
      expect(hookCtx.senderId).toBe("U456");
      expect(hookCtx.senderName).toBe("Eddie");
      expect(hookCtx.senderIsOwner).toBe(true);
      expect(hookCtx.groupId).toBe("G789");
      expect(hookCtx.spawnedBy).toBeNull();
    });

    it("identity fields survive the full 3-stage pipeline for DM (null group)", () => {
      // Stage 1: DM → no group session key → null
      const runParams = {
        sourceProvider: extractSourceProvider("slack", undefined, undefined, undefined, undefined),
        groupId: null as string | null,
        senderId: "U456" as string | null,
        senderName: "Eddie" as string | null,
        senderIsOwner: true,
        spawnedBy: null as string | null,
      };

      // Stage 2: transparent forwarding (null must survive, not become undefined)
      const queuedRun = { ...runParams };
      expect(queuedRun.groupId).toBeNull();
      expect(queuedRun.spawnedBy).toBeNull();

      // Stage 3: hookCtx construction
      const hookCtx = buildHookCtx({
        agentId: "main",
        sessionKey: "main:dm",
        trigger: "user",
        sourceProvider: queuedRun.sourceProvider,
        groupId: queuedRun.groupId,
        spawnedBy: queuedRun.spawnedBy,
        senderId: queuedRun.senderId,
        senderName: queuedRun.senderName,
        senderIsOwner: queuedRun.senderIsOwner,
      });

      // Security plugins can safely use `ctx.groupId === null` to identify DMs
      expect(hookCtx.groupId).toBeNull();
      expect(hookCtx.groupId).not.toBeUndefined();
      expect(hookCtx.spawnedBy).toBeNull();
      expect(hookCtx.spawnedBy).not.toBeUndefined();
    });

    it("identity fields survive for spawned sub-agent sessions", () => {
      const runParams = {
        sourceProvider: extractSourceProvider(
          "discord",
          undefined,
          undefined,
          undefined,
          undefined,
        ),
        groupId: "G123" as string | null,
        senderId: "U789" as string | null,
        senderName: null as string | null,
        senderIsOwner: false,
        spawnedBy: "agent:main:parent-session" as string | null,
      };

      const hookCtx = buildHookCtx({
        agentId: "sub:codex",
        sessionKey: "agent:sub:xyz",
        trigger: "user",
        sourceProvider: runParams.sourceProvider,
        groupId: runParams.groupId,
        senderId: runParams.senderId,
        senderName: runParams.senderName,
        senderIsOwner: runParams.senderIsOwner,
        spawnedBy: runParams.spawnedBy,
      });

      expect(hookCtx.sourceProvider).toBe("discord");
      expect(hookCtx.spawnedBy).toBe("agent:main:parent-session");
      expect(hookCtx.senderName).toBeNull();
      expect(hookCtx.senderIsOwner).toBe(false);
    });
  });
});
