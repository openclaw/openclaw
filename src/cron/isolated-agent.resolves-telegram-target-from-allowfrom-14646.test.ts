import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { telegramOutbound } from "../channels/plugins/outbound/telegram.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";

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
  return withTempHomeBase(fn, { prefix: "openclaw-cron-" });
}

/**
 * Build a Telegram test plugin that mirrors the real dock's resolveAllowFrom
 * behaviour so resolveOutboundTarget can discover the allowFrom list.
 */
function buildTelegramTestPlugin(): ChannelPlugin {
  return {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test stub.",
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
      resolveAllowFrom: ({ cfg }: { cfg: OpenClawConfig }) => {
        const raw = (cfg as Record<string, unknown>).channels as
          | { telegram?: { allowFrom?: Array<string | number> } }
          | undefined;
        return (raw?.telegram?.allowFrom ?? []).map((entry) => String(entry));
      },
    },
    outbound: telegramOutbound,
  };
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

function makeDeps(): CliDeps {
  return {
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "456" }),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

describe("runCronIsolatedAgentTurn — #14646 regression", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(runSubagentAnnounceFlow).mockReset().mockResolvedValue(true);
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: buildTelegramTestPlugin(),
          source: "test",
        },
      ]),
    );
  });

  it("resolves delivery target from allowFrom when to is empty and lastChannel differs", async () => {
    await withTempHome(async (home) => {
      // Main session's lastChannel is webchat — NOT telegram.
      // This previously caused the delivery target to be unresolvable,
      // silently skipping the announce flow (#14646).
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
              lastChannel: "webchat",
              lastTo: "web-user",
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Weather report: sunny" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: {
            telegram: {
              botToken: "t-1",
              allowFrom: [456],
            },
          },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "weather check" }),
          // delivery.to is absent — system must resolve from allowFrom
          delivery: { mode: "announce", channel: "telegram" },
        },
        message: "weather check",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      // The announce flow must be called — target resolved from allowFrom[0].
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const args = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { requesterOrigin?: { channel?: string; to?: string } }
        | undefined;
      expect(args?.requesterOrigin?.channel).toBe("telegram");
      expect(args?.requesterOrigin?.to).toBe("456");
    });
  });

  it("resolves delivery target from allowFrom when to is empty string", async () => {
    await withTempHome(async (home) => {
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
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: {
            telegram: {
              botToken: "t-1",
              allowFrom: [789],
            },
          },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "telegram", to: "" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const args = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { requesterOrigin?: { channel?: string; to?: string } }
        | undefined;
      expect(args?.requesterOrigin?.channel).toBe("telegram");
      expect(args?.requesterOrigin?.to).toBe("789");
    });
  });

  it("still fails when to is empty, no allowFrom, and bestEffort is false", async () => {
    await withTempHome(async (home) => {
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
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const deps = makeDeps();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "Done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg: makeCfg(home, storePath, {
          channels: {
            telegram: {
              botToken: "t-1",
              // No allowFrom configured
            },
          },
        }),
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "telegram", to: "" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      // Should fail because there's no way to resolve the target.
      expect(res.status).toBe("error");
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    });
  });
});
