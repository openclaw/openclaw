import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { enqueueSystemEvent } from "./system-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
});

describe("Ghost reminder bug (issue #13317)", () => {
  it("should NOT trigger CRON_EVENT_PROMPT when only HEARTBEAT_OK is in system events", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ghost-"));
    const storePath = path.join(tmpDir, "sessions.json");
    
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "155462274",
            },
          },
          null,
          2,
        ),
      );

      // Simulate leftover HEARTBEAT_OK from previous heartbeat
      enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });

      // Run heartbeat with cron: reason (simulating cron job firing)
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:test-job",
        deps: {
          sendTelegram,
        },
      });

      expect(result.status).toBe("sent");
      
      // The bug: sendTelegram would be called with a message containing
      // "scheduled reminder" even though no actual reminder content exists.
      // The fix: should use regular heartbeat prompt, NOT CRON_EVENT_PROMPT.
      
      const calls = sendTelegram.mock.calls;
      expect(calls.length).toBe(1);
      const message = calls[0][0].message;
      
      // Should NOT contain the ghost reminder prompt
      expect(message).not.toContain("scheduled reminder has been triggered");
      expect(message).not.toContain("relay this reminder");
      
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("should trigger CRON_EVENT_PROMPT when actual cron message exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
    const storePath = path.join(tmpDir, "sessions.json");
    
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      
      const sessionKey = resolveMainSessionKey(cfg);

      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              lastChannel: "telegram",
              lastProvider: "telegram",
              lastTo: "155462274",
            },
          },
          null,
          2,
        ),
      );

      // Simulate real cron message (not HEARTBEAT_OK)
      enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "cron:reminder-job",
        deps: {
          sendTelegram,
        },
      });

      expect(result.status).toBe("sent");
      
      const calls = sendTelegram.mock.calls;
      expect(calls.length).toBe(1);
      const message = calls[0][0].message;
      
      // SHOULD contain the cron reminder prompt
      expect(message).toContain("scheduled reminder has been triggered");
      
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
