import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { telegramMessagingForTest } from "./outbound/targets.test-helpers.js";

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let testRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;
let fixtureRoot = "";
let fixtureCount = 0;

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  previousRegistry = getActivePluginRegistry();

  const telegramPlugin = createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async ({ to, text, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
      sendMedia: async ({ to, text, mediaUrl, deps, accountId }) => {
        if (!deps?.["telegram"]) {
          throw new Error("sendTelegram missing");
        }
        const res = await (deps["telegram"] as Function)(to, text, {
          verbose: false,
          accountId: accountId ?? undefined,
          mediaUrl,
        });
        return { channel: "telegram", messageId: res.messageId, chatId: res.chatId };
      },
    },
    messaging: telegramMessagingForTest,
  });
  telegramPlugin.config = {
    ...telegramPlugin.config,
    listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? {}),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const channel = cfg.channels?.telegram;
      const normalized = accountId?.trim();
      if (normalized && channel?.accounts?.[normalized]?.allowFrom) {
        return channel.accounts[normalized].allowFrom?.map((entry) => String(entry)) ?? [];
      }
      return channel?.allowFrom?.map((entry) => String(entry)) ?? [];
    },
  };

  testRegistry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(testRegistry);

  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-paused-"));
});

afterAll(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

describe("runHeartbeatOnce — HEARTBEAT.md PAUSED sentinel (#81186)", () => {
  const createHeartbeatDeps = (
    sendTelegram: (
      to: string,
      text: string,
      opts?: unknown,
    ) => Promise<{ messageId: string; chatId: string }>,
    options?: {
      getReplyFromConfig?: HeartbeatDeps["getReplyFromConfig"];
    },
  ): HeartbeatDeps => ({
    telegram: sendTelegram,
    getQueueSize: () => 0,
    nowMs: () => 0,
    webAuthExists: async () => true,
    hasActiveWebListener: () => true,
    ...(options?.getReplyFromConfig ? { getReplyFromConfig: options.getReplyFromConfig } : null),
  });

  async function runPausedScenario(params: { heartbeatContent: string }) {
    const tmpDir = await createCaseDir("hb-paused");
    const storePath = path.join(tmpDir, "sessions.json");
    const workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), params.heartbeatContent, "utf-8");

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    const sessionKey = resolveMainSessionKey(cfg);
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100123",
        },
      }),
    );

    const sendTelegram = vi
      .fn<
        (to: string, text: string, opts?: unknown) => Promise<{ messageId: string; chatId: string }>
      >()
      .mockResolvedValue({ messageId: "m1", chatId: "-100123" });

    const replySpy = vi.fn().mockResolvedValue({ text: "Checked logs and PRs" });

    const res = await runHeartbeatOnce({
      cfg,
      source: "interval",
      intent: "scheduled",
      reason: "interval",
      deps: createHeartbeatDeps(sendTelegram, { getReplyFromConfig: replySpy }),
    });

    return { res, sendTelegram, replySpy };
  }

  it("skips heartbeat when HEARTBEAT.md contains 'PAUSED'", async () => {
    const { res, sendTelegram } = await runPausedScenario({
      heartbeatContent: "PAUSED",
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("heartbeat-paused");
    }
    expect(sendTelegram).toHaveBeenCalledTimes(0);
  });

  it("skips heartbeat when HEARTBEAT.md contains 'paused' (lowercase)", async () => {
    const { res, sendTelegram } = await runPausedScenario({
      heartbeatContent: "paused",
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("heartbeat-paused");
    }
    expect(sendTelegram).toHaveBeenCalledTimes(0);
  });

  it("skips heartbeat when HEARTBEAT.md contains 'Paused' (mixed case)", async () => {
    const { res, sendTelegram } = await runPausedScenario({
      heartbeatContent: "Paused",
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("heartbeat-paused");
    }
    expect(sendTelegram).toHaveBeenCalledTimes(0);
  });

  it("skips heartbeat when HEARTBEAT.md contains '  PAUSED  ' (with whitespace)", async () => {
    const { res, sendTelegram } = await runPausedScenario({
      heartbeatContent: "  PAUSED  ",
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("heartbeat-paused");
    }
    expect(sendTelegram).toHaveBeenCalledTimes(0);
  });

  it("runs heartbeat normally when HEARTBEAT.md contains actionable tasks", async () => {
    const { res, sendTelegram } = await runPausedScenario({
      heartbeatContent: "# HEARTBEAT.md\n\n- Check server logs\n",
    });

    expect(res.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("skips heartbeat with empty-heartbeat-file reason for effectively empty content", async () => {
    const { res, sendTelegram } = await runPausedScenario({
      heartbeatContent: "# HEARTBEAT.md\n\n## Tasks\n\n",
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("empty-heartbeat-file");
    }
    expect(sendTelegram).toHaveBeenCalledTimes(0);
  });
});
