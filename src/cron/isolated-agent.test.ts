import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { ClawdisConfig } from "../config/config.js";
import type { CronJob } from "./types.js";

vi.mock("../auto-reply/command-reply.js", () => ({
  runCommandReply: vi.fn(),
}));

import { runCommandReply } from "../auto-reply/command-reply.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function makeSessionStorePath() {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "clawdis-cron-sessions-"),
  );
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
  );
  return {
    storePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function makeCfg(storePath: string): ClawdisConfig {
  return {
    inbound: {
      reply: {
        mode: "command",
        command: ["echo", "ok"],
        session: {
          store: storePath,
          mainKey: "main",
        },
      },
    },
  } as ClawdisConfig;
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
    vi.mocked(runCommandReply).mockReset();
  });

  it("uses last non-empty agent text as summary", async () => {
    const sessions = await makeSessionStorePath();
    const deps: CliDeps = {
      sendMessageWhatsApp: vi.fn(),
      sendMessageTelegram: vi.fn(),
    };
    vi.mocked(runCommandReply).mockResolvedValue({
      payloads: [{ text: "first" }, { text: " " }, { text: " last " }],
    });

    const res = await runCronIsolatedAgentTurn({
      cfg: makeCfg(sessions.storePath),
      deps,
      job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
      message: "do it",
      sessionKey: "cron:job-1",
      lane: "cron",
    });

    expect(res.status).toBe("ok");
    expect(res.summary).toBe("last");

    await sessions.cleanup();
  });

  it("truncates long summaries", async () => {
    const sessions = await makeSessionStorePath();
    const deps: CliDeps = {
      sendMessageWhatsApp: vi.fn(),
      sendMessageTelegram: vi.fn(),
    };
    const long = "a".repeat(2001);
    vi.mocked(runCommandReply).mockResolvedValue({
      payloads: [{ text: long }],
    });

    const res = await runCronIsolatedAgentTurn({
      cfg: makeCfg(sessions.storePath),
      deps,
      job: makeJob({ kind: "agentTurn", message: "do it", deliver: false }),
      message: "do it",
      sessionKey: "cron:job-1",
      lane: "cron",
    });

    expect(res.status).toBe("ok");
    expect(String(res.summary ?? "")).toMatch(/…$/);

    await sessions.cleanup();
  });

  it("fails delivery without a WhatsApp recipient when bestEffortDeliver=false", async () => {
    const sessions = await makeSessionStorePath();
    const deps: CliDeps = {
      sendMessageWhatsApp: vi.fn(),
      sendMessageTelegram: vi.fn(),
    };
    vi.mocked(runCommandReply).mockResolvedValue({
      payloads: [{ text: "hello" }],
    });

    const res = await runCronIsolatedAgentTurn({
      cfg: makeCfg(sessions.storePath),
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

    await sessions.cleanup();
  });

  it("skips delivery without a WhatsApp recipient when bestEffortDeliver=true", async () => {
    const sessions = await makeSessionStorePath();
    const deps: CliDeps = {
      sendMessageWhatsApp: vi.fn(),
      sendMessageTelegram: vi.fn(),
    };
    vi.mocked(runCommandReply).mockResolvedValue({
      payloads: [{ text: "hello" }],
    });

    const res = await runCronIsolatedAgentTurn({
      cfg: makeCfg(sessions.storePath),
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

    await sessions.cleanup();
  });
});
