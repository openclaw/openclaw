// Covers session idle gating — heartbeat skips when the resolved session has
// been idle too long, preventing silent runaway token burn.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce idle gate", () => {
  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    setHeartbeatsEnabled(true);
    resetHeartbeatEventsForTest();
  });

  /** Shared sandbox that seeds a session with configurable age. */
  async function runIdleTest(params: {
    lastInteractionAt?: number;
    sessionStartedAt?: number;
    updatedAt?: number;
    expectSkipped: boolean;
    expectedReason?: string;
  }) {
    return await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:main";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
            },
          },
        },
        session: { store: storePath },
      };

      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "user",
        lastInteractionAt: params.lastInteractionAt,
        sessionStartedAt: params.sessionStartedAt,
        updatedAt: params.updatedAt,
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      return { result };
    });
  }

  // ---- Active session: heartbeat should run -------------------------------

  it("runs heartbeat when session has recent lastInteractionAt", async () => {
    const { result } = await runIdleTest({
      lastInteractionAt: nowMs - 60_000, // 1 min ago
      updatedAt: nowMs - 60_000,
      expectSkipped: false,
    });
    expect(result.status).toBe("ran");
  });

  // ---- Idle session: heartbeat should skip --------------------------------

  it("skips heartbeat when lastInteractionAt is older than 7 days", async () => {
    const { result } = await runIdleTest({
      lastInteractionAt: nowMs - sevenDaysMs - 60_000, // 7 days + 1 min
      updatedAt: nowMs - 60_000,
      expectSkipped: true,
      expectedReason: "session-idle",
    });
    expect(result.status).toBe("skipped");
    expect((result as { status: "skipped"; reason: string }).reason).toBe("session-idle");
  });

  it("skips heartbeat when lastInteractionAt is exactly at the threshold", async () => {
    const { result } = await runIdleTest({
      lastInteractionAt: nowMs - sevenDaysMs - 1, // just past 7 days
      updatedAt: nowMs - 60_000,
      expectSkipped: true,
    });
    expect(result.status).toBe("skipped");
    expect((result as { status: "skipped"; reason: string }).reason).toBe("session-idle");
  });

  // ---- Fallback: sessionStartedAt -----------------------------------------

  it("falls back to sessionStartedAt when lastInteractionAt is undefined", async () => {
    const { result } = await runIdleTest({
      sessionStartedAt: nowMs - sevenDaysMs - 60_000, // 7+ days ago
      updatedAt: nowMs - 60_000,
      expectSkipped: true,
    });
    expect(result.status).toBe("skipped");
    expect((result as { status: "skipped"; reason: string }).reason).toBe("session-idle");
  });

  // ---- Fallback: updatedAt -------------------------------------------------

  it("falls back to updatedAt when both lastInteractionAt and sessionStartedAt are undefined", async () => {
    const { result } = await runIdleTest({
      updatedAt: nowMs - sevenDaysMs - 60_000, // 7+ days ago
      expectSkipped: true,
    });
    expect(result.status).toBe("skipped");
    expect((result as { status: "skipped"; reason: string }).reason).toBe("session-idle");
  });

  // ---- Active recent session ----------------------------------------------

  it("does not skip heartbeat for a recent sessionStartedAt", async () => {
    const { result } = await runIdleTest({
      sessionStartedAt: nowMs - 60_000, // 1 min ago
      updatedAt: nowMs - 60_000,
      expectSkipped: false,
    });
    expect(result.status).toBe("ran");
  });

  // ---- No entry -----------------------------------------------------------

  it("runs heartbeat when there is no session entry", async () => {
    const result = await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
            },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = "agent:main:main";
      // Deliberately do NOT seed a session entry.
      return await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
    });
    // Without an entry, the idle gate is a no-op and execution continues
    // to the preflight file gate (HEARTBEAT.md is present with content).
    expect(result.status).toBe("ran");
  });
});
