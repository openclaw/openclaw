import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-cron-submodel-" });
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
          lastProvider: "webchat",
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
  overrides: Partial<OpenClawConfig> = {},
): OpenClawConfig {
  const base: OpenClawConfig = {
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
  return { ...base, ...overrides };
}

function makeDeps(): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSlack: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

function makeJob(): CronJob {
  const now = Date.now();
  return {
    id: "job-sub",
    name: "subagent-model-job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do work" },
    state: {},
  };
}

function mockEmbeddedAgent() {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

describe("runCronIsolatedAgentTurn: subagent model resolution (#11461)", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("uses agents.defaults.subagents.model when set", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      mockEmbeddedAgent();

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-5",
              workspace: path.join(home, "openclaw"),
              subagents: { model: "ollama/llama3.2:3b" },
            },
          },
        }),
        deps: makeDeps(),
        job: makeJob(),
        message: "do work",
        sessionKey: "cron:job-sub",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("ollama");
      expect(call?.model).toBe("llama3.2:3b");
    });
  });

  it("explicit job model override takes precedence over subagents.model", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      mockEmbeddedAgent();

      const job = makeJob();
      job.payload = { kind: "agentTurn", message: "do work", model: "openai/gpt-4o" };

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-5",
              workspace: path.join(home, "openclaw"),
              subagents: { model: "ollama/llama3.2:3b" },
            },
          },
        }),
        deps: makeDeps(),
        job,
        message: "do work",
        sessionKey: "cron:job-sub",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4o");
    });
  });

  it("falls back to main model when subagents.model is unset", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      mockEmbeddedAgent();

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps: makeDeps(),
        job: makeJob(),
        message: "do work",
        sessionKey: "cron:job-sub",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-sonnet-4-5");
    });
  });

  it("supports subagents.model with {primary} object format", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      mockEmbeddedAgent();

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-5",
              workspace: path.join(home, "openclaw"),
              subagents: { model: { primary: "google/gemini-2.5-flash" } },
            },
          },
        }),
        deps: makeDeps(),
        job: makeJob(),
        message: "do work",
        sessionKey: "cron:job-sub",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.provider).toBe("google");
      expect(call?.model).toBe("gemini-2.5-flash");
    });
  });
});
