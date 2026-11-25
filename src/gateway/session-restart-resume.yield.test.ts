import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
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
  "lost",
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
    const recovery = [
      "retired-completed",
      "retired-message",
      "nested-retired-message",
      "stopped",
      "lost",
      "interrupted",
    ].includes(source);
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
      expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toEqual({});
      if (source === "lost") {
        subagentRuns.delete(childRunId);
      }
      for (let boot = 0; boot < 2; boot++) {
        const warn = vi.fn();
        await resumeMarkedSessions({
          context: createContext([], () => cfg),
          signal: new AbortController().signal,
          log: { warn },
        });
        const parked = warn.mock.calls.filter(([message]) => message.includes("(yield-waiting)"));
        expect(parked).toEqual(
          [
            "message",
            "nested-message",
            "nested-lost",
            "stale-requester",
            "current-completed",
          ].includes(source)
            ? [[expect.stringContaining(target.sessionKey)]]
            : [],
        );
        const restored = (await readSessionEntryReadOnlyInWorker(target))!;
        expect(restored.resumeAfterRestart).toBeUndefined();
        expect(restored.activeWriterRunId).toBe(runId);
        if (recovery) {
          expect(restored.lifecycleRunId).toBeUndefined();
          expect(restored.status).toBe("killed");
        } else {
          expect(restored.lifecycleRunId).toBe(runId);
          expect(restored.status).toBeUndefined();
          expect(restored.endedAt).toBe(120);
        }
        expect(restored.lastRunError).toBeUndefined();
      }
      expect(resume).toHaveBeenCalledTimes(recovery ? 1 : 0);
      if (recovery) {
        expect(resume.mock.calls[0]?.[1]).toMatchObject({
          sessionKey: target.sessionKey,
          source: "restart",
        });
      }
    } finally {
      resume.mockRestore();
      subagentRuns.delete(childRunId);
      subagentRuns.delete(grandchildRunId);
    }
  }),
);
