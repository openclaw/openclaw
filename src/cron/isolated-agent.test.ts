import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { ClawdisConfig } from "../config/config.js";
import type { CronJob } from "./types.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
}));

import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-cron-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

async function writeSessionStore(home: string) {
  const dir = path.join(home, ".clawdis", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        main: {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastChannel: "webchat",
          lastTo: "",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  return storePath;
}

function makeCfg(
  home: string,
  storePath: string,
  overrides: Partial<ClawdisConfig> = {},
): ClawdisConfig {
  const base: ClawdisConfig = {
    agent: {
      model: "anthropic/claude-opus-4-5",
      workspace: path.join(home, "clawd"),
    },
    session: { store: storePath, mainKey: "main" },
  } as ClawdisConfig;
  return { ...base, ...overrides };
}

function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
    isolation: { postToMainPrefix: "Cron" },
  };
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
  });

  it("uses last non-empty agent text as summary", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "first" }, { text: " " }, { text: " last " }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.summary).toBe("last");
    });
  });

  it("truncates long summaries", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      const long = "a".repeat(2001);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: long }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(String(res.summary ?? "")).toMatch(/…$/);
    });
  });

  it("fails delivery without a WhatsApp recipient when bestEffortDeliver=false", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          deliver: true,
          channel: "whatsapp",
          bestEffortDeliver: false,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.summary).toBe("hello");
      expect(String(res.error ?? "")).toMatch(/requires a recipient/i);
      expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("skips delivery without a WhatsApp recipient when bestEffortDeliver=true", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          deliver: true,
          channel: "whatsapp",
          bestEffortDeliver: true,
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("skipped");
      expect(String(res.summary ?? "")).toMatch(/delivery skipped/i);
      expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
    });
  });

  it("passes telegram token from config for delivery", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn().mockResolvedValue({
          messageId: "t1",
          chatId: "123",
        }),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello from cron" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "";
      try {
        const res = await runCronIsolatedAgentTurn({
          cfg: makeCfg(home, storePath, { telegram: { botToken: "t-1" } }),
          deps,
          job: makeJob({
            kind: "agentTurn",
            message: "do it",
            deliver: true,
            channel: "telegram",
            to: "123",
          }),
          message: "do it",
          sessionKey: "cron:job-1",
          lane: "cron",
        });

        expect(res.status).toBe("ok");
        expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
          "123",
          "hello from cron",
          expect.objectContaining({ token: "t-1" }),
        );
      } finally {
        if (prevTelegramToken === undefined) {
          delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
          process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
        }
      }
    });
  });

  it("delivers via discord when configured", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      const deps: CliDeps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn().mockResolvedValue({
          messageId: "d1",
          channelId: "chan",
        }),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "hello from cron" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          deliver: true,
          channel: "discord",
          to: "channel:1122",
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(deps.sendMessageDiscord).toHaveBeenCalledWith(
        "channel:1122",
        "hello from cron",
        expect.objectContaining({ token: process.env.DISCORD_BOT_TOKEN }),
      );
    });
  });
});
