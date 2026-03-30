import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildAgentPeerSessionKey } from "../routing/session-key.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { telegramMessagingForTest } from "./outbound/targets.test-helpers.js";
import {
  enqueueSystemEvent,
  hasSystemEvents,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

let fixtureRoot = "";
let fixtureCount = 0;

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  previousRegistry = getActivePluginRegistry();

  const telegramPlugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
      sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
          mediaUrl,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
    },
    messaging: telegramMessagingForTest,
  });
  telegramPlugin.config = {
    ...telegramPlugin.config,
    listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const channel = cfg.channels?.telegram;
      const normalized = accountId?.trim();
      if (normalized && channel?.accounts?.[normalized]?.allowFrom) {
        return channel.accounts[normalized].allowFrom?.map((entry) => String(entry)) ?? [];
      }
      return channel?.allowFrom?.map((entry) => String(entry)) ?? [];
    },
  };

  testRegistry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(testRegistry);

  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-session-routing-"));
});

beforeEach(() => {
  resetSystemEventsForTest();
  if (testRegistry) {
    setActivePluginRegistry(testRegistry);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

const createHeartbeatDeps = (
  sendTelegram: (
    to: string,
    text: string,
    opts?: unknown,
  ) => Promise<{ messageId: string; chatId: string }>,
  nowMs = 0,
): HeartbeatDeps => ({
  telegram: sendTelegram,
  getQueueSize: () => 0,
  nowMs: () => nowMs,
  webAuthExists: async () => true,
  hasActiveWebListener: () => true,
});

describe("system-event-triggered heartbeat session routing", () => {
  it("uses configured heartbeat.session instead of the originating DM session key", async () => {
    const tmpDir = await createCaseDir("hb-session-routing");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "123456789",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat:topic:2",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "123456789",
        },
      }),
    );

    // Simulate exec completion system event enqueued into the DM session
    enqueueSystemEvent("exec finished (abc12345, code 0) :: backup finished", {
      sessionKey: dmSessionKey,
      contextKey: "exec:abc12345",
    });

    replySpy.mockResolvedValue([{ text: "Backup completed successfully" }]);
    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    const res = await runHeartbeatOnce({
      cfg,
      reason: "exec-event",
      sessionKey: dmSessionKey, // originating DM session
      deps: createHeartbeatDeps(sendTelegram),
    });

    expect(res.status).toBe("ran");

    // The heartbeat should run in the configured session, NOT the DM session
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: heartbeatSessionKey,
        Provider: "exec-event",
      }),
      expect.objectContaining({ isHeartbeat: true }),
      cfg,
    );

    // Verify it did NOT use the DM session
    const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
    expect(calledCtx.SessionKey).not.toBe(dmSessionKey);

    replySpy.mockRestore();
  });

  it("migrates system events from originating session to heartbeat session", async () => {
    const tmpDir = await createCaseDir("hb-event-migration");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "999888777",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "999888777",
        },
      }),
    );

    // Enqueue exec completion into the DM session (as the real code does)
    enqueueSystemEvent("exec finished (def67890, code 0) :: deploy done", {
      sessionKey: dmSessionKey,
      contextKey: "exec:def67890",
    });

    // Verify event is in the DM session before heartbeat runs
    expect(hasSystemEvents(dmSessionKey)).toBe(true);
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(false);

    replySpy.mockResolvedValue([{ text: "Deploy completed" }]);
    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    await runHeartbeatOnce({
      cfg,
      reason: "exec-event",
      sessionKey: dmSessionKey,
      deps: createHeartbeatDeps(sendTelegram),
    });

    // After heartbeat runs, events should have been drained from the DM session
    expect(hasSystemEvents(dmSessionKey)).toBe(false);

    // Events should be visible in the heartbeat session after migration
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(true);
    const migratedEntries = peekSystemEventEntries(heartbeatSessionKey);
    expect(migratedEntries.length).toBeGreaterThan(0);
    expect(migratedEntries[0].text).toContain("deploy done");

    // The heartbeat prompt should contain the exec event content
    const calledCtx = replySpy.mock.calls[0]?.[0] as { Provider?: string };
    expect(calledCtx.Provider).toBe("exec-event");

    replySpy.mockRestore();
  });

  it("migrates all non-session-scoped events and keeps session-scoped events in originating session", async () => {
    const tmpDir = await createCaseDir("hb-event-filter");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "111222333",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "111222333",
        },
      }),
    );

    // Enqueue a mix of trigger events, general notices, and session-scoped events
    enqueueSystemEvent("exec finished (run-42, code 0) :: backup done", {
      sessionKey: dmSessionKey,
      contextKey: "exec:run-42",
    });
    enqueueSystemEvent("Hook wake: deploy webhook fired", {
      sessionKey: dmSessionKey,
      contextKey: "hook:wake",
    });
    enqueueSystemEvent("Notification: disk usage at 90%", {
      sessionKey: dmSessionKey,
      contextKey: "notifications-event",
    });
    enqueueSystemEvent("Session would be evicted", {
      sessionKey: dmSessionKey,
      contextKey: "session-maintenance:warn",
    });

    expect(peekSystemEventEntries(dmSessionKey)).toHaveLength(4);
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(false);

    replySpy.mockResolvedValue([{ text: "Backup completed" }]);
    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    await runHeartbeatOnce({
      cfg,
      reason: "exec-event",
      sessionKey: dmSessionKey,
      deps: createHeartbeatDeps(sendTelegram),
    });

    // All non-session-scoped events should migrate to the heartbeat session
    const heartbeatEntries = peekSystemEventEntries(heartbeatSessionKey);
    expect(heartbeatEntries).toHaveLength(3);
    expect(heartbeatEntries[0].text).toContain("backup done");
    expect(heartbeatEntries[1].text).toContain("Hook wake");
    expect(heartbeatEntries[2].text).toContain("disk usage");

    // Only session-scoped events should remain in the originating DM session
    const dmEntries = peekSystemEventEntries(dmSessionKey);
    expect(dmEntries).toHaveLength(1);
    expect(dmEntries[0].text).toContain("Session would be evicted");
    expect(dmEntries[0].contextKey).toBe("session-maintenance:warn");

    replySpy.mockRestore();
  });

  it("migrates untagged events (no contextKey) to the heartbeat session alongside tagged events", async () => {
    const tmpDir = await createCaseDir("hb-untagged-events");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "444333222",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "444333222",
        },
      }),
    );

    // Enqueue a tagged exec event and an untagged event — both should migrate
    enqueueSystemEvent("exec finished (xyz99999, code 0) :: build done", {
      sessionKey: dmSessionKey,
      contextKey: "exec:xyz99999",
    });
    enqueueSystemEvent("CLI system event: manual notice", {
      sessionKey: dmSessionKey,
      // No contextKey — untagged events are now migrated so wake-trigger
      // payloads are never lost.
    });

    expect(peekSystemEventEntries(dmSessionKey)).toHaveLength(2);
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(false);

    replySpy.mockResolvedValue([{ text: "Build completed" }]);
    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    await runHeartbeatOnce({
      cfg,
      reason: "exec-event",
      sessionKey: dmSessionKey,
      deps: createHeartbeatDeps(sendTelegram),
    });

    // Both events should migrate to the heartbeat session
    const heartbeatEntries = peekSystemEventEntries(heartbeatSessionKey);
    expect(heartbeatEntries).toHaveLength(2);
    expect(heartbeatEntries[0].text).toContain("build done");
    expect(heartbeatEntries[1].text).toContain("CLI system event");

    // No events should remain in the originating DM session
    expect(hasSystemEvents(dmSessionKey)).toBe(false);

    replySpy.mockRestore();
  });

  it("falls back to forcedSessionKey when heartbeat.session is not configured", async () => {
    const tmpDir = await createCaseDir("hb-no-session-config");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const agentId = "main";
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "555444333",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100group",
            // No session configured — should fall back to forcedSessionKey
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100group",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "555444333",
        },
      }),
    );

    enqueueSystemEvent("Exec completed (ghi11111, code 0) :: test done", {
      sessionKey: dmSessionKey,
    });

    replySpy.mockResolvedValue([{ text: "Test completed" }]);
    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100group" });

    await runHeartbeatOnce({
      cfg,
      reason: "exec-event",
      sessionKey: dmSessionKey,
      deps: createHeartbeatDeps(sendTelegram),
    });

    // Without heartbeat.session configured, the DM session key should be used
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: dmSessionKey,
      }),
      expect.objectContaining({ isHeartbeat: true }),
      cfg,
    );

    replySpy.mockRestore();
  });

  it("does not affect regular scheduled heartbeats without forcedSessionKey", async () => {
    const tmpDir = await createCaseDir("hb-regular-scheduled");
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
      }),
    );

    replySpy.mockResolvedValue([{ text: "All systems normal" }]);
    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    // Regular interval heartbeat — no sessionKey passed
    await runHeartbeatOnce({
      cfg,
      reason: "interval",
      deps: createHeartbeatDeps(sendTelegram),
    });

    // Should use the configured heartbeat session
    expect(replySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        SessionKey: heartbeatSessionKey,
      }),
      expect.objectContaining({ isHeartbeat: true }),
      cfg,
    );

    replySpy.mockRestore();
  });

  it("restores migrated events to originating session when heartbeat is skipped (empty-heartbeat-file)", async () => {
    const tmpDir = await createCaseDir("hb-skip-restore");
    const storePath = path.join(tmpDir, "sessions.json");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "777666555",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "777666555",
        },
      }),
    );

    // Create an empty HEARTBEAT.md so the heartbeat is skipped
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "   \n");

    // Enqueue events into the DM session
    enqueueSystemEvent("exec finished (notify-exit, code 0) :: cleanup done", {
      sessionKey: dmSessionKey,
      contextKey: "exec:notify-exit",
    });
    enqueueSystemEvent("Notification: disk usage warning", {
      sessionKey: dmSessionKey,
      contextKey: "notifications-event",
    });

    expect(peekSystemEventEntries(dmSessionKey)).toHaveLength(2);
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(false);

    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    // Use a reason that does NOT bypass file gates (exec:<id>:exit → "other")
    const res = await runHeartbeatOnce({
      cfg,
      reason: "exec:notify-exit:exit",
      sessionKey: dmSessionKey,
      deps: createHeartbeatDeps(sendTelegram),
    });

    expect(res.status).toBe("skipped");
    expect(res).toHaveProperty("reason", "empty-heartbeat-file");

    // Events must be restored to the originating DM session, not orphaned
    const dmEntries = peekSystemEventEntries(dmSessionKey);
    expect(dmEntries).toHaveLength(2);
    expect(dmEntries[0].text).toContain("cleanup done");
    expect(dmEntries[1].text).toContain("disk usage warning");

    // Heartbeat session should be empty (no orphaned events)
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(false);
  });

  it("preserves concurrent heartbeat-session events when restoring on skip", async () => {
    const tmpDir = await createCaseDir("hb-skip-concurrent");
    const storePath = path.join(tmpDir, "sessions.json");

    const agentId = "main";
    const heartbeatSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId: "-100heartbeat",
    });
    const dmSessionKey = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "direct",
      peerId: "888777666",
    });

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
            to: "-100heartbeat",
            session: heartbeatSessionKey,
          },
        },
      },
      session: { store: storePath },
    };

    await fs.writeFile(
      storePath,
      JSON.stringify({
        [resolveAgentMainSessionKey({ cfg, agentId })]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [heartbeatSessionKey]: {
          sessionId: "sid-heartbeat",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100heartbeat",
        },
        [dmSessionKey]: {
          sessionId: "sid-dm",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "888777666",
        },
      }),
    );

    // Create an empty HEARTBEAT.md so the heartbeat is skipped.
    // Use a real fs.readFile spy to inject a concurrent event during the
    // await gap between migration and the skip check.
    const originalReadFile = fs.readFile;
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      // Let the real readFile run first
      const result = await originalReadFile.apply(fs, args);
      // Simulate a concurrent event arriving in the heartbeat session
      // during the await fs.readFile gap
      enqueueSystemEvent("Concurrent restart notification", {
        sessionKey: heartbeatSessionKey,
        contextKey: "system:restart",
      });
      return result;
    });

    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "   \n");

    // Enqueue an event into the DM session that will be migrated
    enqueueSystemEvent("exec finished (concurrent-test, code 0) :: task done", {
      sessionKey: dmSessionKey,
      contextKey: "exec:concurrent-test",
    });

    expect(peekSystemEventEntries(dmSessionKey)).toHaveLength(1);
    expect(hasSystemEvents(heartbeatSessionKey)).toBe(false);

    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100heartbeat" });

    const res = await runHeartbeatOnce({
      cfg,
      reason: "exec:concurrent-test:exit",
      sessionKey: dmSessionKey,
      deps: createHeartbeatDeps(sendTelegram),
    });

    expect(res.status).toBe("skipped");
    expect(res).toHaveProperty("reason", "empty-heartbeat-file");

    // Migrated events must be restored to the originating DM session
    const dmEntries = peekSystemEventEntries(dmSessionKey);
    expect(dmEntries).toHaveLength(1);
    expect(dmEntries[0].text).toContain("task done");

    // The concurrent event that arrived during the await gap must be
    // preserved in the heartbeat session — NOT dropped
    const heartbeatEntries = peekSystemEventEntries(heartbeatSessionKey);
    expect(heartbeatEntries).toHaveLength(1);
    expect(heartbeatEntries[0].text).toBe("Concurrent restart notification");
    expect(heartbeatEntries[0].contextKey).toBe("system:restart");

    readFileSpy.mockRestore();
  });
});
