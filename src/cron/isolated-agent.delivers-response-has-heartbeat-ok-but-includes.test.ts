import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, writeSessionStore } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

let tempRoot = "";
let tempHomeId = 0;

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  if (!tempRoot) {
    throw new Error("temp root not initialized");
  }
  const home = path.join(tempRoot, `case-${tempHomeId++}`);
  await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), {
    recursive: true,
  });
  const snapshot = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");

  if (process.platform === "win32") {
    const driveMatch = home.match(/^([A-Za-z]:)(.*)$/);
    if (driveMatch) {
      process.env.HOMEDRIVE = driveMatch[1];
      process.env.HOMEPATH = driveMatch[2] || "\\";
    }
  }

  try {
    return await fn(home);
  } finally {
    const restoreKey = (key: keyof typeof snapshot) => {
      const value = snapshot[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restoreKey("HOME");
    restoreKey("USERPROFILE");
    restoreKey("HOMEDRIVE");
    restoreKey("HOMEPATH");
    restoreKey("OPENCLAW_HOME");
    restoreKey("OPENCLAW_STATE_DIR");
  }
}

async function createTelegramDeliveryFixture(home: string): Promise<{
  storePath: string;
  deps: CliDeps;
}> {
  const storePath = await writeSessionStore(home, {
    lastProvider: "telegram",
    lastChannel: "telegram",
    lastTo: "123",
  });
  const deps: CliDeps = {
    sendMessageSlack: vi.fn(),
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn().mockResolvedValue({
      messageId: "t1",
      chatId: "123",
    }),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
  return { storePath, deps };
}

function mockEmbeddedAgentPayloads(payloads: Array<{ text: string; mediaUrl?: string }>) {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

async function runTelegramAnnounceTurn(params: {
  home: string;
  storePath: string;
  deps: CliDeps;
  cfg?: ReturnType<typeof makeCfg>;
  signal?: AbortSignal;
}) {
  return runCronIsolatedAgentTurn({
    cfg: params.cfg ?? makeCfg(params.home, params.storePath),
    deps: params.deps,
    job: {
      ...makeJob({
        kind: "agentTurn",
        message: "do it",
      }),
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    },
    message: "do it",
    sessionKey: "cron:job-1",
    signal: params.signal,
    lane: "cron",
  });
}

describe("runCronIsolatedAgentTurn", () => {
  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-heartbeat-suite-"));
  });

  afterAll(async () => {
    if (!tempRoot) {
      return;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  it("does not fan out telegram cron delivery across allowFrom entries", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);
      mockEmbeddedAgentPayloads([
        { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
      ]);

      const cfg = makeCfg(home, storePath, {
        channels: {
          telegram: {
            botToken: "tok",
            allowFrom: ["111", "222", "333"],
          },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "deliver once",
          }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "deliver once",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(deps.sendMessageTelegram).toHaveBeenCalledTimes(1);
      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "123",
        "HEARTBEAT_OK",
        expect.objectContaining({ accountId: undefined }),
      );
    });
  });

  it("handles media heartbeat delivery and announce cleanup modes", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);

      // Media should still be delivered even if text is just HEARTBEAT_OK.
      mockEmbeddedAgentPayloads([
        { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
      ]);

      const mediaRes = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
      });

      expect(mediaRes.status).toBe("ok");
      expect(deps.sendMessageTelegram).toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

      vi.mocked(runSubagentAnnounceFlow).mockClear();
      vi.mocked(deps.sendMessageTelegram).mockClear();
      mockEmbeddedAgentPayloads([{ text: "HEARTBEAT_OK 🦞" }]);

      const cfg = makeCfg(home, storePath);
      cfg.agents = {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          heartbeat: { ackMaxChars: 0 },
        },
      };

      const keepRes = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
          }),
          delivery: { mode: "announce", channel: "last" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(keepRes.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const keepArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { cleanup?: "keep" | "delete" }
        | undefined;
      expect(keepArgs?.cleanup).toBe("keep");
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();

      vi.mocked(runSubagentAnnounceFlow).mockClear();

      const deleteRes = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
          }),
          deleteAfterRun: true,
          delivery: { mode: "announce", channel: "last" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(deleteRes.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const deleteArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { cleanup?: "keep" | "delete" }
        | undefined;
      expect(deleteArgs?.cleanup).toBe("delete");
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
    });
  });

  it("skips structured outbound delivery when timeout abort is already set", async () => {
    await withTempHome(async (home) => {
      const { storePath, deps } = await createTelegramDeliveryFixture(home);
      const controller = new AbortController();
      controller.abort("cron: job execution timed out");

      mockEmbeddedAgentPayloads([
        { text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" },
      ]);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        signal: controller.signal,
      });

      expect(res.status).toBe("error");
      expect(res.error).toContain("timed out");
      expect(deps.sendMessageTelegram).not.toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });

  it("uses a unique announce childRunId for each cron run", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, {
        lastProvider: "telegram",
        lastChannel: "telegram",
        lastTo: "123",
      });
      const deps: CliDeps = {
        sendMessageSlack: vi.fn(),
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "final summary" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const cfg = makeCfg(home, storePath);
      const job = makeJob({ kind: "agentTurn", message: "do it" });
      job.delivery = { mode: "announce", channel: "last" };

      const nowSpy = vi.spyOn(Date, "now");
      let now = Date.now();
      nowSpy.mockImplementation(() => now);
      try {
        await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: "do it",
          sessionKey: "cron:job-1",
          lane: "cron",
        });
        now += 5;
        await runCronIsolatedAgentTurn({
          cfg,
          deps,
          job,
          message: "do it",
          sessionKey: "cron:job-1",
          lane: "cron",
        });
      } finally {
        nowSpy.mockRestore();
      }

      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(2);
      const firstArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { childRunId?: string }
        | undefined;
      const secondArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[1]?.[0] as
        | { childRunId?: string }
        | undefined;
      expect(firstArgs?.childRunId).toBeTruthy();
      expect(secondArgs?.childRunId).toBeTruthy();
      expect(secondArgs?.childRunId).not.toBe(firstArgs?.childRunId);
    });
  });
});
