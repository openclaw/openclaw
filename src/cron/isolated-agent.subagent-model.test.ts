import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import type { CronJob } from "./types.js";

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

async function runSubagentModelCase(params: {
  home: string;
  cfgOverrides?: Partial<OpenClawConfig>;
  jobModelOverride?: string;
}) {
  const storePath = await writeSessionStore(params.home);
  mockEmbeddedAgent();
  const job = makeJob();
  if (params.jobModelOverride) {
    job.payload = { kind: "agentTurn", message: "do work", model: params.jobModelOverride };
  }

  await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, storePath, params.cfgOverrides),
    deps: makeDeps(),
    job,
    message: "do work",
    sessionKey: "cron:job-sub",
    lane: "cron",
  });

  return vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
}

describe("runCronIsolatedAgentTurn: subagent model resolution (#11461)", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it.each([
    {
      name: "uses agents.defaults.subagents.model when set",
      cfgOverrides: {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-5",
            subagents: { model: "ollama/llama3.2:3b" },
          },
        },
      } satisfies Partial<OpenClawConfig>,
      expectedProvider: "ollama",
      expectedModel: "llama3.2:3b",
    },
    {
      name: "falls back to main model when subagents.model is unset",
      cfgOverrides: undefined,
      expectedProvider: "anthropic",
      expectedModel: "claude-sonnet-4-5",
    },
    {
      name: "supports subagents.model with {primary} object format",
      cfgOverrides: {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-5",
            subagents: { model: { primary: "google/gemini-2.5-flash" } },
          },
        },
      } satisfies Partial<OpenClawConfig>,
      expectedProvider: "google",
      expectedModel: "gemini-2.5-flash",
    },
  ])("$name", async ({ cfgOverrides, expectedProvider, expectedModel }) => {
    await withTempHome(async (home) => {
      const resolvedCfg =
        cfgOverrides === undefined
          ? undefined
          : ({
              agents: {
                defaults: {
                  ...cfgOverrides.agents?.defaults,
                  workspace: path.join(home, "openclaw"),
                },
              },
            } satisfies Partial<OpenClawConfig>);
      const call = await runSubagentModelCase({ home, cfgOverrides: resolvedCfg });
      expect(call?.provider).toBe(expectedProvider);
      expect(call?.model).toBe(expectedModel);
    });
  });

  it("explicit job model override takes precedence over subagents.model", async () => {
    await withTempHome(async (home) => {
      const call = await runSubagentModelCase({
        home,
        cfgOverrides: {
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-5",
              workspace: path.join(home, "openclaw"),
              subagents: { model: "ollama/llama3.2:3b" },
            },
          },
        },
        jobModelOverride: "openai/gpt-4o",
      });
      expect(call?.provider).toBe("openai");
      expect(call?.model).toBe("gpt-4o");
    });
  });
});
