/**
 * Regression test for #14743: Cron job delivery modes (announce)
 * fail to deliver messages to Telegram despite successful execution.
 *
 * Root causes:
 * 1. Telegram outbound adapter lacked a `resolveTarget` function, so bare
 *    Telegram IDs were not normalized through `normalizeTelegramMessagingTarget`
 *    before reaching the outbound send path. Without `resolveTarget`, there was
 *    also no `allowFrom` fallback when `to` was empty in implicit/heartbeat mode.
 * 2. When the main session's `lastChannel` didn't match the requested delivery
 *    channel (e.g. after a gateway restart cleared the session state, or the
 *    user's last interaction was on a different channel), `resolveDeliveryTarget`
 *    couldn't find a `to`. A session store fallback now scans other sessions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { telegramOutbound } from "../channels/plugins/outbound/telegram.js";
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
  return withTempHomeBase(fn, { prefix: "openclaw-cron-14743-" });
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
    sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "123" }),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

describe("issue #14743 – cron delivery to Telegram", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(runSubagentAnnounceFlow).mockReset().mockResolvedValue(true);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
          source: "test",
        },
      ]),
    );
  });

  it("normalizes bare numeric Telegram ID in delivery target via resolveTarget", async () => {
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
            lastChannel: "telegram",
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
          channels: { telegram: { botToken: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "telegram", to: "123456789" },
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
      expect(args?.requesterOrigin?.channel).toBe("telegram");
      // Bare ID should be normalized through normalizeTelegramMessagingTarget
      expect(args?.requesterOrigin?.to).toBe("telegram:123456789");
    });
  });

  it("preserves telegram: prefixed target through delivery pipeline", async () => {
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
          channels: { telegram: { botToken: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "telegram", to: "telegram:987654321" },
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
      expect(args?.requesterOrigin?.to).toBe("telegram:987654321");
    });
  });

  it("finds Telegram target from other session entries when main session lastChannel differs", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      // Main session is on webchat, but a Telegram DM session exists
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "web-user-1",
          },
          "agent:main:telegram:dm:user:555": {
            sessionId: "telegram-dm-session",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "555",
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
          channels: { telegram: { botToken: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "telegram" },
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
      expect(args?.requesterOrigin?.channel).toBe("telegram");
      // Found from the Telegram DM session entry, then normalized
      expect(args?.requesterOrigin?.to).toBe("telegram:555");
    });
  });

  it("still errors when no session entry has a Telegram target and to is empty", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      // No session has ever used Telegram
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
          channels: { telegram: { botToken: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "telegram" },
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

  it("normalizes target from session store fallback through resolveTarget", async () => {
    await withTempHome(async (home) => {
      const dir = path.join(home, ".openclaw", "sessions");
      await fs.mkdir(dir, { recursive: true });
      const storePath = path.join(dir, "sessions.json");
      // Main session on webchat, Telegram session has bare numeric lastTo
      await fs.writeFile(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastChannel: "webchat",
            lastTo: "web-user-1",
          },
          "agent:main:telegram:dm:user:444": {
            sessionId: "tg-session",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "444555666",
          },
        }),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Here is the report" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: { telegram: { botToken: "test-token" } },
        }),
        deps,
        job: makeJob({
          delivery: { mode: "announce", channel: "telegram" },
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
      // Found from the Telegram session, then normalized through resolveTarget
      expect(args?.requesterOrigin?.to).toBe("telegram:444555666");
    });
  });
});
