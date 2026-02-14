import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
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

let fixtureRoot = "";
let fixtureCount = 0;

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = path.join(fixtureRoot, `home-${fixtureCount++}`);
  await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  return await fn(home);
}

async function writeSessionStore(home: string) {
  const dir = path.join(home, ".openclaw", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastChannel: "telegram",
          lastTo: "123",
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

function makeJob(payload: CronJob["payload"]): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "job-1",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

describe("runCronIsolatedAgentTurn", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-fixtures-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
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

  it("handles media heartbeat delivery and announce cleanup modes", async () => {
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

      // Media should still be delivered even if text is just HEARTBEAT_OK.
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const mediaRes = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: "do it",
          }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(mediaRes.status).toBe("ok");
      expect(deps.sendMessageTelegram).toHaveBeenCalled();
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();

      vi.mocked(runSubagentAnnounceFlow).mockClear();
      vi.mocked(deps.sendMessageTelegram).mockClear();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK 🦞" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

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
});
