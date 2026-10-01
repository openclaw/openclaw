/**
 * Session lifecycle state tests for restart recovery and foreground-owner generations.
 */
import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";

const persistenceMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionEntry: vi.fn(),
}));
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// Lifecycle projection formats stored failures without initializing provider runtime.
vi.mock("../plugins/loader-runtime-load.js", () => {
  throw new Error("Session lifecycle presentation imported plugin runtime ownership");
});

vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: persistenceMocks.updateSessionEntry,
  appendSessionTranscriptReport: vi.fn(async () => ({ ok: true, value: undefined })),
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: persistenceMocks.loadSessionEntry,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => loggerMocks,
}));

import {
  persistLifecycleThroughMockedStore,
  type LifecycleEvent,
} from "./session-lifecycle-state.test-support.js";

function persistLifecycle(entry: SessionEntry, event: LifecycleEvent): Promise<SessionEntry> {
  return persistLifecycleThroughMockedStore(persistenceMocks, {
    sessionKey: "agent:main:main",
    entry,
    event,
  });
}

describe("session lifecycle state recovery", () => {
  it("preserves recovery state for a late interrupted-run event", async () => {
    const mainRestartRecovery = {
      cycleId: "cycle-1",
      revision: 2,
      chargedAttempts: 2,
    };
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
        mainRestartRecovery,
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "restart-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", aborted: true, stopReason: "restart" },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
      mainRestartRecovery,
    });
  });

  it("settles a hard timeout even when shutdown already marked the run for recovery", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_000,
        lifecycleRunId: "timed-out-run",
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "timed-out-run", lifecycleGeneration }],
        mainRestartRecovery: { cycleId: "cycle-1", revision: 2, chargedAttempts: 2 },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "timed-out-run",
        lifecycleGeneration,
        data: {
          phase: "error",
          aborted: true,
          stopReason: "restart",
          timeoutPhase: "provider",
          providerStarted: true,
          endedAt: 2_000,
        },
      },
    );
    expect(persisted).toMatchObject({ status: "timeout", abortedLastRun: false, endedAt: 2_000 });
    expect(persisted.restartRecoveryRuns).toBeUndefined();
    expect(persisted.mainRestartRecovery).toBeUndefined();
  });

  it("ignores an unidentified completion while recovery remains pending", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        lifecycleRunId: "foreground-run",
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 2,
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: true,
    });
    expect(persisted.restartRecoveryRuns).toEqual([
      { runId: "restart-run", lifecycleGeneration: "pre-restart" },
    ]);
    expect(persisted.mainRestartRecovery).toMatchObject({ cycleId: "cycle-1" });
  });

  it("applies the terminal snapshot for the foreground owner run", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
          { runId: "foreground-run", lifecycleGeneration },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 2,
          foregroundClaims: {
            lifecycleGeneration,
            tokens: ["owner-claim"],
            runIdsByClaimId: { "owner-claim": "foreground-run" },
          },
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "foreground-run",
        lifecycleGeneration,
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "done",
      endedAt: 1_800,
      abortedLastRun: false,
    });
    expect(persisted.restartRecoveryRuns).toBeUndefined();
    expect(persisted.mainRestartRecovery).toBeUndefined();
    expect(persisted.lifecycleRunId).toBeUndefined();
  });

  it("clears every generation of a resumed run when its current owner completes", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        lifecycleRunId: "recovery-run",
        abortedLastRun: false,
        restartRecoveryRuns: [
          { runId: "recovery-run", lifecycleGeneration: "pre-restart" },
          { runId: "recovery-run", lifecycleGeneration },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 5,
          chargedAttempts: 2,
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "recovery-run",
        lifecycleGeneration,
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "done",
      endedAt: 1_800,
      abortedLastRun: false,
    });
    expect(persisted.restartRecoveryRuns).toBeUndefined();
    expect(persisted.mainRestartRecovery).toBeUndefined();
    expect(persisted.lifecycleRunId).toBeUndefined();
  });

  it("reports an exact recovery run's terminal outcome after persistence", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    loggerMocks.warn.mockClear();
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        lifecycleRunId: "recovery-run",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryRuns: [
          { runId: "recovery-run", lifecycleGeneration: "pre-restart" },
          { runId: "recovery-run", lifecycleGeneration },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 5,
          chargedAttempts: 2,
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "recovery-run",
        lifecycleGeneration,
        mainSessionRestartRecovery: true,
        data: { phase: "error", endedAt: 1_800, error: "provider failed" },
      },
    );

    expect(persisted.status).toBe("failed");
    expect(persisted.mainRestartRecovery).toBeUndefined();
    expect(persisted.restartRecoveryRuns).toBeUndefined();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "main-session restart recovery terminal: session=agent:main:main run=recovery-run status=error reason=failed",
    );
  });

  it("keeps an active recovery when an older same-run terminal arrives", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        lifecycleRunId: "recovery-run",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryRuns: [
          { runId: "recovery-run", lifecycleGeneration: "pre-restart" },
          { runId: "recovery-run", lifecycleGeneration },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 5,
          chargedAttempts: 2,
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "recovery-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
      mainRestartRecovery: { cycleId: "cycle-1" },
    });
    expect(persisted.restartRecoveryTerminalRunIds).toBeUndefined();
    expect(persisted.lifecycleRunId).toBe("recovery-run");
  });

  it("does not settle a foreground owner from a stale lifecycle generation", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        lifecycleRunId: "foreground-run",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
          { runId: "foreground-run", lifecycleGeneration: "pre-restart" },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 2,
          foregroundClaims: {
            lifecycleGeneration: "pre-restart",
            tokens: ["owner-claim"],
            runIdsByClaimId: { "owner-claim": "foreground-run" },
          },
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "foreground-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "pre-restart" }],
      mainRestartRecovery: {
        foregroundClaims: { tokens: ["owner-claim"] },
      },
    });
    expect(persisted.lifecycleRunId).toBe("foreground-run");
  });

  it("clears only the completed recovery marker", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        lifecycleRunId: "interrupted-run",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "completed-run", lifecycleGeneration: "pre-restart" },
          { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
        ],
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "completed-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted.restartRecoveryRuns).toEqual([
      { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
    ]);
    expect(persisted.status).toBe("running");
    expect(persisted.lifecycleRunId).toBe("interrupted-run");
  });
});
