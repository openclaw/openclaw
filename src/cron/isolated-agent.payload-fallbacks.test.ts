import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));
vi.mock("../agents/model-fallback.js", () => ({
  runWithModelFallback: vi.fn(),
}));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-cron-fallbacks-" });
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
    name: "Test Job",
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

function makeDeps(): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

describe("runCronIsolatedAgentTurn payload.fallbacks", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { provider: "anthropic", model: "claude-opus-4-5", contextLength: 200000 },
      { provider: "anthropic", model: "claude-haiku-4-5-20251001", contextLength: 200000 },
      { provider: "opencode", model: "kimi-k2.5-free", contextLength: 128000 },
    ]);
    vi.mocked(runWithModelFallback).mockReset();
    vi.mocked(runWithModelFallback).mockImplementation(async (params) => {
      const result = await params.run(params.provider, params.model);
      return { result, provider: params.provider, model: params.model, attempts: [] };
    });
  });

  it("passes payload.fallbacks to runWithModelFallback", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
      });

      await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps: makeDeps(),
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          model: "anthropic/claude-haiku-4-5-20251001",
          fallbacks: ["opencode/kimi-k2.5-free"],
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(runWithModelFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbacksOverride: ["opencode/kimi-k2.5-free"],
        }),
      );
    });
  });

  it("returns error for invalid fallbacks (not an array)", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps: makeDeps(),
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          // @ts-expect-error - testing invalid input
          fallbacks: "not-an-array",
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.error).toContain("invalid fallbacks: expected array");
    });
  });

  it("returns error for invalid fallback entry (not a string)", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath),
        deps: makeDeps(),
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          // @ts-expect-error - testing invalid input
          fallbacks: [123],
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.error).toContain("invalid fallbacks: expected array of strings");
    });
  });

  it("returns error for disallowed fallback model", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(loadModelCatalog).mockResolvedValue([
        { provider: "anthropic", model: "claude-opus-4-5", contextLength: 200000 },
      ]);

      // Config with allowlist to restrict models (without allowlist, any model is allowed)
      const cfg = makeCfg(home, storePath);
      cfg.agents = {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: {
            "anthropic/claude-opus-4-5": true,
          },
        },
      };

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          fallbacks: ["nonexistent/model"],
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("error");
      expect(res.error).toContain("fallback");
    });
  });

  it("empty payload.fallbacks disables agent fallbacks", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      // Config has agent-level fallbacks (agents.list is an array)
      const cfg = makeCfg(home, storePath);
      cfg.agents = {
        ...cfg.agents,
        list: [
          {
            id: "main",
            default: true,
            model: { primary: "anthropic/claude-opus-4-5", fallbacks: ["opencode/kimi-k2.5-free"] },
          },
        ],
      };

      await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          fallbacks: [], // Explicitly empty - should disable fallbacks
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      // Empty array should be passed, not the agent fallbacks
      expect(runWithModelFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbacksOverride: [],
        }),
      );
    });
  });

  it("uses agent fallbacks when payload.fallbacks is undefined", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      // Config has agent-level fallbacks (agents.list is an array)
      const cfg = makeCfg(home, storePath);
      cfg.agents = {
        ...cfg.agents,
        list: [
          {
            id: "main",
            default: true,
            model: { primary: "anthropic/claude-opus-4-5", fallbacks: ["opencode/kimi-k2.5-free"] },
          },
        ],
      };

      await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: makeJob({
          kind: "agentTurn",
          message: "do it",
          // No fallbacks in payload - should use agent fallbacks
        }),
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      // Should get agent fallbacks since payload.fallbacks is undefined
      expect(runWithModelFallback).toHaveBeenCalledWith(
        expect.objectContaining({
          fallbacksOverride: ["opencode/kimi-k2.5-free"],
        }),
      );
    });
  });
});
