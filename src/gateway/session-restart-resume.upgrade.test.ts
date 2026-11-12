import { expect, it, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { resumeMarkedSessions } from "./session-restart-resume.js";

it.for(["message", "interrupted", "shared-message"] as const)(
  "recovers v2026.11.2 serialized yield records without new markers (%s)",
  (source) =>
    withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async (state) => {
        const storePath =
          source === "shared-message" ? state.statePath("shared.sqlite") : undefined;
        const agentId = storePath ? "other" : "main";
        const waiting = source !== "interrupted";
        const cfg = {
          agents: { entries: { main: {}, ...(storePath ? { other: {} } : {}) } },
          ...(storePath ? { session: { store: storePath } } : {}),
        };
        setRuntimeConfigSnapshot(cfg);
        const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
        const target = { agentId, sessionKey: `agent:${agentId}:dashboard:stable-root`, storePath };
        const runId = "stable-root-run";
        const childRunId = "stable-child-run";
        const session = {
          sessionId: "stable-root",
          lifecycleRevision: "stable-revision",
          lifecycleRunId: runId,
          activeWriterRunId: runId,
          startedAt: 100,
          endedAt: 120,
          updatedAt: 120,
          abortedLastRun: false,
        };
        replaceSessionEntrySync(target, session);
        // Literal stable writer shapes, not current fixture factories or serialization.
        // v2026.11.2 (b556fdf457b0) has neither resumeAfterRestart nor requesterRunId.
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(JSON.stringify(session), target.sessionKey);
        runOpenClawStateWriteTransaction((stateDatabase) =>
          writeSubagentRunValuesInDatabase(
            stateDatabase,
            [
              {
                run_id: childRunId,
                child_session_key: "agent:main:dashboard:stable-child",
                requester_session_key: target.sessionKey,
                controller_session_key: null,
                requester_store_path: storePath ?? null,
                controller_store_path: null,
                created_at: 105,
                payload_json: JSON.stringify({
                  parentCompletion: {
                    runId: childRunId,
                    childSessionKey: "agent:main:dashboard:stable-child",
                    childAgentId: "main",
                    childSessionIdentity: { sessionId: "stable-child" },
                    requesterSessionKey: target.sessionKey,
                    requesterAgentId: agentId,
                    requesterDisplayKey: "stable-root",
                    completionRequesterSessionId: session.sessionId,
                    completionRequesterLifecycleRevision: session.lifecycleRevision,
                    completionTarget: "parent",
                    task: "Preserve the synthetic stable task",
                    cleanup: "keep",
                    createdAt: 105,
                    expectsCompletionMessage: true,
                    execution: waiting
                      ? { status: "terminal", startedAt: 105, endedAt: 115 }
                      : {
                          status: "interrupted",
                          startedAt: 105,
                          interruptedAt: 130,
                          interruptionReason: "gateway-restart",
                        },
                    pauseReason: waiting ? "sessions_yield" : undefined,
                    waitForMessage: waiting ? true : undefined,
                    completion: { required: true },
                    delivery: {
                      status: "pending",
                      ...(waiting ? { disposition: "intentional_non_delivery" } : {}),
                    },
                    requesterSettleWake: {
                      status: "pending",
                      attemptCount: 0,
                      batchRunIds: [childRunId],
                      requesterYieldBatch: true,
                      ...(waiting ? { afterRequesterYield: true } : {}),
                      yieldedFinalDeliverable: true,
                      rearmGeneration: 1,
                    },
                  },
                }),
              },
            ],
            [],
          ),
        );
        clearSubagentRunsReadCacheForTest();
        const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
          accepted: Promise.resolve({ ok: true }),
          id: "stable-root-resume",
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
          cancel: () => false,
        });
        try {
          expect(await restoreSubagentRunsFromDisk({ runs: subagentRuns })).toBe(1);
          expect(subagentRuns.get(childRunId)?.requesterSettleWake).not.toHaveProperty(
            "requesterRunId",
          );
          expect(
            (await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart,
          ).toBeUndefined();
          for (let boot = 0; boot < 2; boot++) {
            await resumeMarkedSessions({
              context: createContext([], () => cfg),
              signal: new AbortController().signal,
              log: { warn() {} },
            });
          }
          expect(resume.mock.calls.map(([, options]) => options.sessionKey)).toEqual(
            source === "interrupted" ? [target.sessionKey] : [],
          );
          if (waiting) {
            expect(await readSessionEntryReadOnlyInWorker(target)).toMatchObject(session);
          }
        } finally {
          resume.mockRestore();
          subagentRuns.delete(childRunId);
          clearSubagentRunsReadCacheForTest();
        }
      },
    ),
);
