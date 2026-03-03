import "../../src/cron/isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedPiAgent } from "../../src/agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "../../src/cron/isolated-agent.js";
import {
  makeCfg,
  makeJob,
  writeSessionStoreEntries,
} from "../../src/cron/isolated-agent.test-harness.js";

describe("runCronIsolatedAgentTurn webhook session continuity (#29518)", () => {
  let tempRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    const localTmpRoot = path.join(process.cwd(), "tmp");
    await fs.mkdir(localTmpRoot, { recursive: true });
    tempRoot = await fs.mkdtemp(path.join(localTmpRoot, "openclaw-cron-e2e-"));
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  const withTempHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
    const home = path.join(tempRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
    const snapshot = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      OPENCLAW_HOME: process.env.OPENCLAW_HOME,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
    try {
      return await fn(home);
    } finally {
      if (snapshot.HOME === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = snapshot.HOME;
      }
      if (snapshot.USERPROFILE === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = snapshot.USERPROFILE;
      }
      if (snapshot.OPENCLAW_HOME === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = snapshot.OPENCLAW_HOME;
      }
      if (snapshot.OPENCLAW_STATE_DIR === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = snapshot.OPENCLAW_STATE_DIR;
      }
    }
  };

  const makeDeps = () => ({
    sendMessageSlack: vi.fn(),
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  });

  it("reuses existing hook session when sessionKey is stable", async () => {
    await withTempHome(async (home) => {
      const sessionKey = "hook:agent:stable-1";
      const agentSessionKey = `agent:main:${sessionKey}`;
      const storePath = await writeSessionStoreEntries(home, {
        [agentSessionKey]: {
          sessionId: "existing-hook-session",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps: makeDeps(),
        job: makeJob({ kind: "agentTurn", message: "hello", deliver: false }),
        message: "hello",
        sessionKey,
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.sessionId).toBe("existing-hook-session");
    });
  });

  it("keeps cron:* isolated runs stateless even when sessionKey already exists", async () => {
    await withTempHome(async (home) => {
      const sessionKey = "cron:job-1";
      const agentSessionKey = `agent:main:${sessionKey}`;
      const storePath = await writeSessionStoreEntries(home, {
        [agentSessionKey]: {
          sessionId: "existing-cron-session",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps: makeDeps(),
        job: makeJob({ kind: "agentTurn", message: "hello", deliver: false }),
        message: "hello",
        sessionKey,
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.sessionId).not.toBe("existing-cron-session");
    });
  });
});
