import { afterEach, expect, test } from "vitest";
import { claimAgentSessionWriter } from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import { commitMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-store.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  seedSessionTranscript,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([false, true])(
  "sessions.recover reconciles an interrupted writer only without a live owner (live=%s)",
  async (live) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:orphaned-recovery";
    const sessionId = "orphaned-recovery-session";
    const runId = "orphaned-recovery-run";
    const cycleId = "orphaned-recovery-cycle";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const target = { agentId: "main", sessionKey, storePath };
    await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: 1_000 } } });
    await persistGatewaySessionLifecycleEvent({
      sessionKey,
      event: {
        ts: 1_000,
        runId,
        sessionId,
        lifecycleGeneration,
        data: { phase: "start", startedAt: 1_000 },
      },
    });
    await commitMainSessionRecovery({
      target,
      command: { kind: "mark_interrupted", cycleId, now: 2_000 },
    });
    await commitMainSessionRecovery({
      target,
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 3_000,
        observation: { sessionId, cycleId, revision: 1 },
        runId,
        executionIdentity: { state: "disabled" },
      },
    });
    await commitMainSessionRecovery({
      target,
      command: { kind: "admit_recovery", sessionId, runId, lifecycleGeneration, now: 3_000 },
    });
    await commitMainSessionRecovery({
      target,
      command: {
        kind: "register_recovery_turn",
        sessionId,
        runId,
        lifecycleGeneration,
        cycleId,
        attempt: 1,
      },
    });
    await claimAgentSessionWriter({
      sessionId,
      sessionKey,
      sessionTarget: { ...target, sessionId },
      workspaceDir: dir,
      config: getRuntimeConfig(),
      prompt: "finish the interrupted work",
      timeoutMs: 60_000,
      runId,
    });
    await seedSessionTranscript({
      ...target,
      sessionId,
      messages: [{ role: "user", content: "preserve this conversation" }],
    });
    const stranded = loadSessionEntry(target);
    expect(stranded).toMatchObject({
      status: "running",
      activeWriterRunId: runId,
      lifecycleRunId: runId,
      abortedLastRun: false,
      mainRestartRecovery: { cycleId, revision: 4, chargedAttempts: 1, startedAttempt: 1 },
      restartRecoveryRuns: [{ runId, lifecycleGeneration }],
    });
    expect(stranded?.restartRecoveryTerminalRunIds).toBeUndefined();
    const liveClaim = live
      ? claimAgentRunContext(
          runId,
          { sessionKey, sessionId, lifecycleGeneration },
          { trackOwner: true },
        )
      : undefined;
    try {
      const recovered = await directSessionReq("sessions.recover", {
        agentId: "main",
        key: sessionKey,
      });
      if (live) {
        expect(recovered.ok).toBe(false);
        expect(loadSessionEntry(target)).toEqual(stranded);
        return;
      }
      expect(recovered.ok, JSON.stringify(recovered.error)).toBe(true);
      expect(recovered.payload).toMatchObject({
        key: sessionKey,
        sessionId,
        continuation: { status: "started" },
      });
      const restored = loadSessionEntry(target);
      expect(restored?.archivedAt).toBeUndefined();
      expect(restored?.activeWriterRunId).not.toBe(runId);
      expect(restored?.lifecycleRunId).not.toBe(runId);
      expect(JSON.stringify(await loadTranscriptEvents({ ...target, sessionId }))).toContain(
        "preserve this conversation",
      );
    } finally {
      releaseAgentRunContext(runId, liveClaim);
    }
  },
);
