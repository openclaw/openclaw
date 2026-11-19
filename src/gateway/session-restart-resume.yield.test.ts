import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

it.for([
  "message",
  "retired-message",
  "nested-message",
  "nested-retired-message",
  "nested-lost",
  "stale-requester",
  "current-completed",
  "retired-completed",
  "stopped",
  "interrupted",
] as const)("recovers a parked dashboard root from its recorded wake source (%s)", (source) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:parked-root",
      sessionId: "parked-root",
    };
    const runId =
      source === "message"
        ? `announce:requester-settle:main:${target.sessionKey}:parked-child-run`
        : "parked-root-run";
    const lifecycleRevision = "parked-root-revision";
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      lifecycleRevision,
      activeWriterRunId: runId,
      updatedAt: 100,
    });
    if (source === "message") {
      await appendTranscriptMessage(target, {
        message: {
          role: "user",
          content: "Captured child result",
          timestamp: 90,
          idempotencyKey: `${runId}:user`,
          provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        },
      });
    }
    for (const event of [
      { ts: 100, data: { phase: "start", startedAt: 100 } },
      {
        ts: 120,
        data: {
          phase: "end",
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    ]) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        event: { ...event, runId, sessionId: target.sessionId },
      });
    }
    const childRunId = "parked-child-run";
    const childSessionKey = "agent:main:dashboard:parked-child";
    const childSessionId = "parked-child";
    const childRevision = "parked-child-revision";
    // Every session without a reachable wake resumes itself; its parent stays parked.
    const parkedRoot = ["message", "nested-message", "current-completed", "interrupted"].includes(
      source,
    );
    const completed = source === "current-completed" || source === "retired-completed";
    const child = createSubagentRunRecord({
      runId: childRunId,
      childSessionKey,
      childAgentId: "main",
      childSessionIdentity: { sessionId: childSessionId, lifecycleRevision: childRevision },
      requesterSessionKey: target.sessionKey,
      requesterAgentId: target.agentId,
      completionRequesterSessionId: target.sessionId,
      completionRequesterLifecycleRevision: lifecycleRevision,
      expectsCompletionMessage: true,
      endedAt: source === "interrupted" ? undefined : 110,
      outcome: completed ? { status: "ok" } : undefined,
      endedReason:
        source === "stopped" ? "subagent-killed" : completed ? "subagent-complete" : undefined,
      pauseReason:
        completed || source === "stopped" || source === "interrupted"
          ? undefined
          : "sessions_yield",
      waitForMessage: ["message", "retired-message", "stale-requester"].includes(source)
        ? true
        : undefined,
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        requesterRunId: source === "stale-requester" ? "older-root-run" : runId,
        batchRunIds: [childRunId],
      },
    });
    subagentRuns.set(childRunId, child);
    // The interrupted child is still executing when shutdown snapshots live work.
    const childOperation =
      source === "interrupted"
        ? (() => {
            const scope = {
              agentId: "main",
              sessionKey: childSessionKey,
              sessionId: childSessionId,
            };
            replaceSessionEntrySync(scope, {
              sessionId: childSessionId,
              lifecycleRevision: childRevision,
              updatedAt: 100,
            });
            return createReplyOperation({
              ...scope,
              resetTriggered: false,
              target: captureSessionTarget({
                ...scope,
                incarnation: childSessionId,
                storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
              }),
            });
          })()
        : undefined;
    if (source === "retired-completed" || source === "retired-message") {
      subagentRuns.retireCompletionAuthority(child);
    }
    const grandchildRunId = "parked-grandchild-run";
    if (source === "nested-message" || source === "nested-retired-message") {
      subagentRuns.set(
        grandchildRunId,
        createSubagentRunRecord({
          runId: grandchildRunId,
          childSessionKey: "agent:main:dashboard:parked-grandchild",
          childAgentId: "main",
          requesterSessionKey: childSessionKey,
          requesterAgentId: "main",
          completionRequesterSessionId: childSessionId,
          completionRequesterLifecycleRevision: childRevision,
          expectsCompletionMessage: true,
          endedAt: 105,
          pauseReason: "sessions_yield",
          waitForMessage: true,
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            requesterRunId: childRunId,
            batchRunIds: [grandchildRunId],
          },
        }),
      );
      if (source === "nested-retired-message") {
        subagentRuns.retireCompletionAuthority(subagentRuns.get(grandchildRunId)!);
      }
    }
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    try {
      await persistRunningSessionsForRestart({ cfg });
      childOperation?.complete();
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({});
      for (let boot = 0; boot < 2; boot++) {
        const warn = vi.fn();
        await resumeMarkedSessions({
          context: createContext([], () => cfg),
          signal: new AbortController().signal,
          log: { warn },
        });
        const parked = warn.mock.calls.filter(([message]) => message.includes("(yield-waiting)"));
        expect(parked).toEqual(parkedRoot ? [[expect.stringContaining(target.sessionKey)]] : []);
        const restored = (await readSessionEntryReadOnlyInWorker(target))!;
        expect(restored.resumeAfterRestart).toBeUndefined();
        expect(restored.activeWriterRunId).toBe(runId);
        expect(restored.lastRunError).toBeUndefined();
        if (parkedRoot) {
          expect(restored.lifecycleRunId).toBe(runId);
          expect(restored.status).toBeUndefined();
          expect(restored.endedAt).toBe(120);
        } else {
          expect(restored.lifecycleRunId).toBeUndefined();
          expect(restored.status).toBe("killed");
        }
      }
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual(
        source === "interrupted" ? [childSessionKey] : parkedRoot ? [] : [target.sessionKey],
      );
    } finally {
      resume.mockRestore();
      subagentRuns.delete(childRunId);
      subagentRuns.delete(grandchildRunId);
    }
  }),
);

it("resumes a yielded subagent whose wake did not survive the restart", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    // The worker yielded on a background command; that wake lived only in memory.
    const target = {
      agentId: "main",
      sessionKey: "agent:main:subagent:background-worker",
      sessionId: "background-worker",
    };
    const runId = "background-worker-run";
    const lifecycleRevision = "background-worker-revision";
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      lifecycleRevision,
      activeWriterRunId: runId,
      spawnedBy: "agent:main:dashboard:worker-parent",
      updatedAt: 100,
    });
    for (const event of [
      { ts: 100, data: { phase: "start", startedAt: 100 } },
      {
        ts: 120,
        data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" },
      },
    ]) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        event: { ...event, runId, sessionId: target.sessionId },
      });
    }
    subagentRuns.set(
      runId,
      createSubagentRunRecord({
        runId,
        childSessionKey: target.sessionKey,
        childAgentId: "main",
        childSessionIdentity: { sessionId: target.sessionId, lifecycleRevision },
        requesterSessionKey: "agent:main:dashboard:worker-parent",
        requesterAgentId: "main",
        expectsCompletionMessage: true,
        endedAt: 120,
        pauseReason: "sessions_yield",
      }),
    );
    const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
      accepted: Promise.resolve({ ok: true }),
      id: "restart-input",
      settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
      cancel: () => false,
    });
    try {
      await persistRunningSessionsForRestart({ cfg });
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({});
      await resumeMarkedSessions({
        context: createContext([], () => cfg),
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      });
      expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual([
        target.sessionKey,
      ]);
      const restored = (await readSessionEntryReadOnlyInWorker(target))!;
      expect(restored.resumeAfterRestart).toBeUndefined();
      expect(restored.lastRunError).toBeUndefined();
      expect(restored.status).not.toBe("failed");
    } finally {
      resume.mockRestore();
      subagentRuns.delete(runId);
    }
  }));
