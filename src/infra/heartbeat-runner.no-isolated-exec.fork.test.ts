/**
 * Fork test: exec/cron/wake heartbeat events must NOT use isolated sessions.
 *
 * When isolatedSession is true, the heartbeat runner creates a `:heartbeat`
 * suffixed session key. But system events (exec completions, cron results)
 * are enqueued on the BASE session key. The isolated session drains from
 * the wrong key and never sees the events, causing the model to fall back
 * to HEARTBEAT.md tasks instead of relaying exec output.
 *
 * This test verifies that event-driven heartbeat wakes run on the base
 * session (SessionKey matches the original session key, not `:heartbeat`).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

let fixtureRoot = "";
let fixtureCount = 0;

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

const createHeartbeatDeps = (nowMs = 0): HeartbeatDeps => ({
  getQueueSize: () => 0,
  nowMs: () => nowMs,
});

beforeAll(async () => {
  fixtureRoot = path.join(os.tmpdir(), `heartbeat-no-isolated-exec-${Date.now()}`);
  await fs.mkdir(fixtureRoot, { recursive: true });

  const whatsappPlugin = createOutboundTestPlugin({
    id: "whatsapp",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "whatsapp", messageId: "m1", chatId: "c1" }),
    },
  });
  whatsappPlugin.config = {
    ...whatsappPlugin.config,
    resolveAllowFrom: () => ["*"],
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" }]),
  );
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  resetSystemEventsForTest();
});

describe("heartbeat exec/cron/wake events skip isolated sessions", () => {
  async function setupCase(prefix: string) {
    const tmpDir = await createCaseDir(prefix);
    const storePath = path.join(tmpDir, "sessions.json");
    const heartbeatFile = path.join(tmpDir, "HEARTBEAT.md");
    await fs.writeFile(heartbeatFile, "# Heartbeat\n- Check things\n");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "none",
            isolatedSession: true,
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };

    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid-base",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
      }),
    );

    return { cfg, sessionKey, storePath, tmpDir };
  }

  it("exec-event wake runs on base session key, not isolated", async () => {
    const { cfg, sessionKey } = await setupCase("exec-no-isolate");

    enqueueSystemEvent("Exec finished (test-sess, code 0) :: output here", {
      sessionKey,
      contextKey: "exec:test",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: "Relayed output" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "exec-event",
        sessionKey,
        deps: createHeartbeatDeps(),
      });

      expect(res.status).toBe("ran");
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string; Provider?: string };
      // Must use the base session key, NOT the `:heartbeat` suffixed one
      expect(calledCtx.SessionKey).toBe(sessionKey);
      expect(calledCtx.SessionKey).not.toContain(":heartbeat");
      expect(calledCtx.Provider).toBe("exec-event");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("cron-event wake runs on base session key, not isolated", async () => {
    const { cfg, sessionKey } = await setupCase("cron-no-isolate");

    enqueueSystemEvent("Cron: maintenance task completed", {
      sessionKey,
      contextKey: "cron:maintenance",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: "Cron handled" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "cron:maintenance",
        sessionKey,
        deps: createHeartbeatDeps(),
      });

      expect(res.status).toBe("ran");
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string; Provider?: string };
      expect(calledCtx.SessionKey).toBe(sessionKey);
      expect(calledCtx.SessionKey).not.toContain(":heartbeat");
      expect(calledCtx.Provider).toBe("cron-event");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("wake reason runs on base session key, not isolated", async () => {
    const { cfg, sessionKey } = await setupCase("wake-no-isolate");

    enqueueSystemEvent("Node reconnected", {
      sessionKey,
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: HEARTBEAT_PROMPT });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "wake",
        sessionKey,
        deps: createHeartbeatDeps(),
      });

      expect(res.status).toBe("ran");
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
      expect(calledCtx.SessionKey).toBe(sessionKey);
      expect(calledCtx.SessionKey).not.toContain(":heartbeat");
    } finally {
      replySpy.mockRestore();
    }
  });

  it("periodic interval heartbeat DOES use isolated session", async () => {
    const { cfg } = await setupCase("interval-isolates");

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    try {
      const res = await runHeartbeatOnce({
        cfg,
        reason: "interval",
        deps: createHeartbeatDeps(),
      });

      expect(res.status).toBe("ran");
      const calledCtx = replySpy.mock.calls[0]?.[0] as { SessionKey?: string };
      // Periodic heartbeats SHOULD use isolated sessions
      expect(calledCtx.SessionKey).toContain(":heartbeat");
    } finally {
      replySpy.mockRestore();
    }
  });
});
