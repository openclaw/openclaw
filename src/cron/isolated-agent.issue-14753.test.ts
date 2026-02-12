/**
 * Regression test for #14753: Cron job delivery modes (announce/deliver)
 * fail to post messages to Discord despite successful execution.
 *
 * Root causes:
 * 1. Bare numeric Discord channel IDs (e.g. "1234567890123456789") were not
 *    normalized to "channel:1234567890123456789" before reaching
 *    sendMessageDiscord, causing "Ambiguous Discord recipient" errors that
 *    were silently swallowed by best-effort delivery.
 * 2. Discord guild messages don't call updateLastRoute on the main session,
 *    so resolveDeliveryTarget couldn't find a Discord target when `to` was
 *    omitted. The session store fallback (from #14646) fixes this.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { discordOutbound } from "../channels/plugins/outbound/discord.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));
vi.mock("../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-cron-14753-" });
}

function makeCfg(
  home: string,
  storePath: string,
  overrides: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  const base: OpenClawConfig = {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  return { ...base, ...overrides };
}

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "daily-digest",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run daily digest" },
    state: {},
    ...overrides,
  };
}

function makeDeps(): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn().mockResolvedValue({ messageId: "d1", channelId: "ch123" }),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

describe("issue #14753 – cron delivery to Discord", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(runSubagentAnnounceFlow).mockReset().mockResolvedValue(true);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({ id: "discord", outbound: discordOutbound }),
          source: "test",
        },
      ]),
    );
  });

  it("normalizes bare numeric Discord channel ID in delivery target", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastChannel: "discord",
            lastTo: "user:111222333",
          },
        }),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Weather report: sunny skies" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { discord: { token: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "discord", to: "1234567890123456789" },
        }),
        message: "run daily digest",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const args = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as {
        requesterOrigin?: { channel?: string; to?: string };
      };
      expect(args?.requesterOrigin?.channel).toBe("discord");
      // Bare ID should be normalized to channel:ID
      expect(args?.requesterOrigin?.to).toBe("channel:1234567890123456789");
    });
  });

  it("preserves channel: prefixed Discord target", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
          },
        }),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Weather report: sunny skies" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { discord: { token: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "deliver", channel: "discord", to: "channel:9876543210" },
        }),
        message: "run daily digest",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const args = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as {
        requesterOrigin?: { channel?: string; to?: string };
      };
      expect(args?.requesterOrigin?.to).toBe("channel:9876543210");
    });
  });

  it("finds Discord target from other session entries when main session lastChannel differs", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      // Main session is on webchat, but a Discord DM session exists
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "web-user-1",
          },
          "agent:main:discord:dm:user:555": {
            sessionId: "discord-dm-session",
            updatedAt: Date.now(),
            lastChannel: "discord",
            lastTo: "user:555",
          },
        }),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Weather report: sunny skies" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { discord: { token: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "discord", to: "" },
        }),
        message: "run daily digest",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const args = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as {
        requesterOrigin?: { channel?: string; to?: string };
      };
      expect(args?.requesterOrigin?.channel).toBe("discord");
      // Found from the Discord DM session entry, then normalized
      expect(args?.requesterOrigin?.to).toBe("user:555");
    });
  });

  it("still errors when no session entry has a Discord target and to is empty", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      // No session has ever used Discord
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "web-user-1",
          },
        }),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Weather report: sunny skies" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { discord: { token: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "discord", to: "" },
        }),
        message: "run daily digest",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.error).toBe("cron delivery target is missing");
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });

  it("normalizes bare ID from session store fallback through resolveTarget", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      // Main session on webchat, Discord session has bare numeric lastTo
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "web-user-1",
          },
          "agent:main:discord:channel:777": {
            sessionId: "discord-channel-session",
            updatedAt: Date.now(),
            lastChannel: "discord",
            lastTo: "channel:777888999",
          },
        }),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Weather report: sunny skies" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { discord: { token: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "discord" },
        }),
        message: "run daily digest",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const args = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as {
        requesterOrigin?: { channel?: string; to?: string };
      };
      expect(args?.requesterOrigin?.channel).toBe("discord");
      expect(args?.requesterOrigin?.to).toBe("channel:777888999");
    });
  });
});
