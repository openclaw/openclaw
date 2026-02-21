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
  return withTempHomeBase(fn, { prefix: "openclaw-cron-exec-" });
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
    id: "job-exec-1",
    name: "job-exec-1",
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

function makeDeps(): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "123" }),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

describe("runCronIsolatedAgentTurn – exec overrides (#11559)", () => {
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

  it("passes global tools.exec config as execOverrides", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const cfg = makeCfg(home, storePath, {
        tools: { exec: { ask: "off", host: "gateway", security: "full" } },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: makeJob({ kind: "agentTurn", message: "test exec" }),
        message: "test exec",
        sessionKey: "cron:job-exec-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.execOverrides).toEqual(
        expect.objectContaining({ ask: "off", host: "gateway", security: "full" }),
      );
    });
  });

  it("agent-specific exec config takes precedence over global", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const cfg = makeCfg(home, storePath, {
        tools: { exec: { ask: "always", host: "sandbox", security: "deny" } },
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "openclaw"),
          },
          list: [
            {
              id: "cron_bot",
              tools: { exec: { ask: "off", host: "gateway", security: "full" } },
            },
          ],
        },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: {
          ...makeJob({ kind: "agentTurn", message: "exec test" }),
          agentId: "cron_bot",
        },
        message: "exec test",
        sessionKey: "cron:job-exec-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      // Agent-specific exec config should win.
      expect(call?.execOverrides).toEqual(
        expect.objectContaining({ ask: "off", host: "gateway", security: "full" }),
      );
    });
  });

  it("falls back to global exec when agent has no tools.exec", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const cfg = makeCfg(home, storePath, {
        tools: { exec: { ask: "off", host: "sandbox", security: "allowlist" } },
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-5",
            workspace: path.join(home, "openclaw"),
          },
          list: [
            {
              id: "writer",
              model: "openai/gpt-4o",
              // No tools.exec here — global should be used.
            },
          ],
        },
      });

      await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: {
          ...makeJob({ kind: "agentTurn", message: "write" }),
          agentId: "writer",
        },
        message: "write",
        sessionKey: "cron:job-exec-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.execOverrides).toEqual(
        expect.objectContaining({ ask: "off", host: "sandbox", security: "allowlist" }),
      );
    });
  });

  it("does not pass execOverrides when no exec config is set", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });

      const cfg = makeCfg(home, storePath);

      await runCronIsolatedAgentTurn({
        cfg,
        deps: makeDeps(),
        job: makeJob({ kind: "agentTurn", message: "check" }),
        message: "check",
        sessionKey: "cron:job-exec-1",
        lane: "cron",
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.execOverrides).toBeUndefined();
    });
  });
});
