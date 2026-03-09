import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey, resolveStorePath } from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";
import { seedMainSessionStore } from "./heartbeat-runner.test-utils.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let fixtureRoot = "";
let fixtureCount = 0;
let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

const createCaseDir = async (prefix: string) => {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram" });
  const registry = createTestRegistry({ telegram: telegramPlugin });
  setActivePluginRegistry(registry);
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hb-session-lane-"));
});

afterAll(async () => {
  if (previousRegistry) setActivePluginRegistry(previousRegistry);
  await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  resetSystemEventsForTest();
});

describe("heartbeat runner skips when target session lane is busy", () => {
  it("returns requests-in-flight when session lane has queued work", async () => {
    const caseDir = await createCaseDir("session-lane-busy");
    const workspaceDir = path.join(caseDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const cfg: OpenClawConfig = {
      auth: { profiles: {} },
      agents: {
        defaults: {
          heartbeat: { every: "30m" },
          model: { primary: "test/model" },
        },
        list: {},
      },
      channels: {
        telegram: {
          enabled: true,
          token: "fake",
          allowFrom: ["123"],
        },
      },
      workspaceDir,
    } as unknown as OpenClawConfig;

    const storePath = resolveStorePath(cfg);
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "123",
    });

    // Enqueue a system event so the heartbeat has something to process
    enqueueSystemEvent("Exec completed (test-id, code 0) :: test output", {
      sessionKey,
    });

    // Mock getQueueSize: main lane is free (0), but session lane is busy (1)
    const getQueueSize = vi.fn((lane?: string) => {
      if (!lane || lane === "main") return 0;
      if (lane.startsWith("session:")) return 1; // session lane is busy
      return 0;
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

    const result = await runHeartbeatOnce({
      cfg,
      deps: { getQueueSize, nowMs: () => Date.now() } as HeartbeatDeps,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("requests-in-flight");
    // getReplyFromConfig should NOT have been called — heartbeat was skipped
    // before reaching the agent run.
    expect(replySpy).not.toHaveBeenCalled();

    replySpy.mockRestore();
  });

  it("proceeds normally when session lane is idle", async () => {
    const caseDir = await createCaseDir("session-lane-idle");
    const workspaceDir = path.join(caseDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });

    const cfg: OpenClawConfig = {
      auth: { profiles: {} },
      agents: {
        defaults: {
          heartbeat: { every: "30m" },
          model: { primary: "test/model" },
        },
        list: {},
      },
      channels: {
        telegram: {
          enabled: true,
          token: "fake",
          allowFrom: ["123"],
        },
      },
      workspaceDir,
    } as unknown as OpenClawConfig;

    const storePath = resolveStorePath(cfg);
    await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "123",
    });

    // Both lanes idle
    const getQueueSize = vi.fn((_lane?: string) => 0);

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig").mockResolvedValue({
      text: "HEARTBEAT_OK",
      model: "test/model",
    } as any);

    const result = await runHeartbeatOnce({
      cfg,
      deps: { getQueueSize, nowMs: () => Date.now() } as HeartbeatDeps,
    });

    // Should have proceeded past the lane checks and called getReplyFromConfig
    expect(replySpy).toHaveBeenCalled();
    expect(result.status).toBe("ran");

    replySpy.mockRestore();
  });
});
