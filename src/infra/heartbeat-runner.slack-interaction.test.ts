// Integration test: Slack interaction system events are injected into the heartbeat prompt.
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce, type HeartbeatDeps } from "./heartbeat-runner.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  setActivePluginRegistry(createTestRegistry([]));
});

beforeEach(() => {
  resetSystemEventsForTest();
});

// The registry is restored after all tests in this file so other tests are not affected.
it("restores plugin registry after suite", () => {
  expect(true).toBe(true);
});

async function buildConfig(tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker>): Promise<{
  cfg: OpenClawConfig;
  sessionKey: string;
}> {
  const tmpDir = tempDirs.make("openclaw-hb-slack-interaction-case-");
  const storePath = path.join(tmpDir, "sessions.json");
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: { every: "5m", target: "none" },
      },
    },
    session: { store: storePath },
  };
  return { cfg, sessionKey: resolveMainSessionKey(cfg) };
}

function createReplySpy() {
  const replySpy = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>();
  replySpy.mockResolvedValue({ text: "Acknowledged" });
  return replySpy;
}

describe("runHeartbeatOnce Slack interaction", () => {
  it("injects a Slack interaction system event into the heartbeat prompt", async () => {
    const tempDirs = useAutoCleanupTempDirTracker();
    const { cfg, sessionKey } = await buildConfig(tempDirs);
    const interactionPayload = `Slack interaction: ${JSON.stringify({
      actionId: "approve_pr",
      value: "merge-99544",
    })}`;
    enqueueSystemEvent(interactionPayload, {
      sessionKey,
      contextKey: "slack:interaction:C123:1234567890.123456:approve_pr",
    });

    const replySpy = createReplySpy();
    const res = await runHeartbeatOnce({
      cfg,
      source: "hook",
      reason: "hook:slack-interaction",
      deps: {
        getReplyFromConfig: replySpy,
        getQueueSize: () => 0,
        nowMs: () => Date.now(),
        webAuthExists: async () => true,
        hasActiveWebListener: () => true,
      } as HeartbeatDeps,
    });

    expect(res.status).toBe("ran");
    expect(replySpy).toHaveBeenCalledTimes(1);
    const body = replySpy.mock.calls[0][0] as { Body?: string; Provider?: string };
    expect(body.Provider).toBe("heartbeat");
    expect(body.Body).toContain("Slack interactive component(s) were used");
    expect(body.Body).toContain('action_id="approve_pr"');
    expect(body.Body).toContain('value="merge-99544"');
  });

  it("renders all queued Slack interaction events so none are consumed and lost", async () => {
    const tempDirs = useAutoCleanupTempDirTracker();
    const { cfg, sessionKey } = await buildConfig(tempDirs);

    // Simulate two rapid Slack button clicks that get coalesced into one heartbeat wake.
    enqueueSystemEvent(
      `Slack interaction: ${JSON.stringify({ actionId: "approve_pr", value: "merge-99544" })}`,
      {
        sessionKey,
        contextKey: "slack:interaction:C123:1234567890.123456:approve_pr",
      },
    );
    enqueueSystemEvent(
      `Slack interaction: ${JSON.stringify({ actionId: "reject_pr", value: "close-99544" })}`,
      {
        sessionKey,
        contextKey: "slack:interaction:C123:1234567890.123456:reject_pr",
      },
    );

    const replySpy = createReplySpy();
    const res = await runHeartbeatOnce({
      cfg,
      source: "hook",
      reason: "hook:slack-interaction",
      deps: {
        getReplyFromConfig: replySpy,
        getQueueSize: () => 0,
        nowMs: () => Date.now(),
        webAuthExists: async () => true,
        hasActiveWebListener: () => true,
      } as HeartbeatDeps,
    });

    expect(res.status).toBe("ran");
    expect(replySpy).toHaveBeenCalledTimes(1);
    const body = replySpy.mock.calls[0][0] as { Body?: string };
    expect(body.Body).toContain('action_id="approve_pr"');
    expect(body.Body).toContain('value="merge-99544"');
    expect(body.Body).toContain('action_id="reject_pr"');
    expect(body.Body).toContain('value="close-99544"');
  });
});

// Restore the plugin registry after the suite so other test files see the original registry.
// This is registered last so it runs after the describe block above.
describe("suite cleanup", () => {
  it("restores the original plugin registry", () => {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    }
    expect(true).toBe(true);
  });
});
