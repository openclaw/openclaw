import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import * as completionStore from "../agents/subagents/completion/subagent-completion-admission.store.js";
import * as completion from "../agents/subagents/completion/subagent-completion-delivery.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import { createSubagentRegistryCompletionRuntime } from "../agents/subagents/registry/subagent-registry-completion-runtime.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  mutateSubagentRuns,
  restoreSubagentRunsFromDisk,
} from "../agents/subagents/registry/subagent-registry-persistence.js";
import { bindSubagentRunRecord } from "../agents/subagents/registry/subagent-registry.store.codec.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { readSubagentRun } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { getSubagentRunRuntimeKey } from "../agents/subagents/registry/subagent-run-generation.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.test-support.js";
import {
  enqueueClaimedSessionDelivery,
  loadPendingSessionDelivery,
  markSessionDeliverySettlement,
} from "../infra/session-delivery-queue-storage.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../infra/session-delivery-queue.records.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as sentinel from "./server-restart-sentinel.js";
import { activateGatewayScheduledServices } from "./server-runtime-services.js";

const { resume } = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({ resumeSubagentRun: resume }));
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop() {} }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  resume.mockClear();
  resetGatewayWorkAdmission();
});

describe("registered correlated completion recovery custody", () => {
  it.for([
    { change: "none", outcome: "moved-to-failed" },
    { change: "default", outcome: "recovered" },
    { change: "file", outcome: "recovered" },
    { change: "successor", outcome: "recovered" },
    { change: "default after commit", outcome: "recovered" },
    { change: "cleanup released at receipt", outcome: "recovered" },
    { change: "hydration pending", outcome: "recovered" },
  ] as const)("settles $outcome with $change ownership change", async ({ change, outcome }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      resetGatewayWorkAdmission();
      const cfg = {};
      setRuntimeConfigSnapshot(cfg);
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = createTestGatewayScheduler(clock.clock);
      const context = captureOpenClawStateWorkerContext();
      const now = Date.now();
      let child = createSubagentRunRecord({
        runId: "retained-completion",
        childSessionKey: "agent:main:subagent:retained-completion",
        requesterSessionKey: "agent:main:retained-requester",
        requesterAgentId: "main",
        createdAt: now - 20,
        endedAt: now - 10,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        ...(change === "cleanup released at receipt" ? { cleanupHandled: true } : {}),
        completion: { required: true, resultText: "Retained result", capturedAt: now - 10 },
        delivery: {
          status: "in_progress",
          disposition: "session_queued",
          generation: 1,
          deadlineAt: now + 60_000,
        },
      });
      // This is an existing producer's durable receipt, not a new creation path.
      const { id: queueId } = await enqueueClaimedSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: child.requesterSessionKey,
          message: "retained completion",
          messageId: "retained-completion-message",
          owner: {
            kind: "subagent_completion",
            runId: child.runId,
            taskId: child.runId,
            generation: 1,
            deadlineAt: now + 60_000,
          },
        },
        0,
        context,
      );
      child.delivery!.queueId = queueId;
      const queued = await loadPendingSessionDelivery(queueId, context);
      if (!queued) {
        throw new Error("Expected the retained queue owner");
      }
      await markSessionDeliverySettlement(queued, outcome, context);
      const persist = (root: string) => {
        const database = openOpenClawStateDatabase({
          env: { ...state.env, OPENCLAW_STATE_DIR: root },
        });
        writeSubagentRunValuesInDatabase(database, [bindSubagentRunRecord(child)], []);
        return database;
      };
      const database = persist(state.stateDir);
      if (change === "hydration pending") {
        const store = await import("../state/openclaw-state-db-readonly.js");
        const unavailable = vi
          .spyOn(store, "executeExistingOpenClawStateRead")
          .mockImplementationOnce(async (_options, command) => {
            expect(command).toEqual({
              type: "subagents.restore",
            });
            throw new Error("registry hydration read unavailable");
          });
        try {
          await expect(
            restoreSubagentRunsFromDisk({ runs: subagentRuns, mergeOnly: true }),
          ).rejects.toThrow("registry hydration read unavailable");
        } finally {
          unavailable.mockRestore();
        }
      }
      if (change !== "hydration pending") {
        await restoreSubagentRunsFromDisk({ runs: subagentRuns });
        child = expectDefined(subagentRuns.get(child.runId), "restored completion owner");
      }
      const replacementRoot = state.path("replacement");
      const replacingSource =
        change === "default" || change === "file" || change === "default after commit";
      const replacement = replacingSource ? persist(replacementRoot) : undefined;
      const before = structuredClone(child);
      const replacementBefore = replacement && readSubagentRun(replacement, child.runId);
      let cleanupRelease: Promise<void> | undefined;
      if (change === "cleanup released at receipt") {
        const failedCompletion = vi
          .fn()
          .mockRejectedValue(new Error("terminal effects unavailable"));
        const fallbackResume = vi.fn(() => {
          expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("delivered");
        });
        const completionRuntime = createSubagentRegistryCompletionRuntime({
          runs: subagentRuns,
          resumed: new Set([getSubagentRunRuntimeKey(child)]),
          retryTimers: new Set(),
          completeSubagentRun: failedCompletion,
          scheduleSweep: vi.fn(),
          resumeRun: fallbackResume,
          warn: vi.fn(),
        });
        let released = false;
        probe.command(stateWorker, async (command, executeOptions, scope) => {
          const receipt = await scope.execute(command, executeOptions);
          if (command.type === "sessionDelivery.mutateSubagentCompletion" && !released) {
            released = true;
            // The cleanup successor waits for this ACK to release row admission.
            cleanupRelease = completionRuntime
              .completeSubagentRunWithRecovery(
                {
                  runId: child.runId,
                  expectedEntry: child,
                  endedAt: now - 10,
                  outcome: { status: "ok" },
                  reason: SUBAGENT_ENDED_REASON_COMPLETE,
                  triggerCleanup: true,
                },
                "queued-completion-retry",
              )
              .then(() => {
                expect(failedCompletion).toHaveBeenCalledTimes(2);
                expect(fallbackResume).toHaveBeenCalledOnce();
                expect(subagentRuns.get(child.runId)?.cleanupHandled).toBe(false);
              });
          }
          return receipt;
        });
      }
      const deliver = vi.spyOn(sentinel, "deliverQueuedSessionDelivery");
      const settle = completion.settleCorrelatedSubagentDelivery;
      const settled = vi
        .spyOn(completion, "settleCorrelatedSubagentDelivery")
        .mockImplementation(async (...args) => {
          if (change === "default") {
            vi.stubEnv("OPENCLAW_STATE_DIR", replacementRoot);
          } else if (change === "file") {
            await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
            await closeOpenClawStateDatabaseByPathAsync(replacement!.path);
            await fs.rename(
              context.admission.databasePath,
              `${context.admission.databasePath}.retired`,
            );
            await fs.rename(replacement!.path, context.admission.databasePath);
          }
          return settle(...args);
        });
      let successor: typeof child | undefined;
      if (change === "successor" || change === "default after commit") {
        const write = completionStore.settleSubagentCompletionDelivery;
        let changed = false;
        vi.spyOn(completionStore, "settleSubagentCompletionDelivery").mockImplementation(
          async (...args) => {
            await write(...args);
            if (changed) {
              return;
            }
            changed = true;
            if (change === "successor") {
              await mutateSubagentRuns([child.runId], (rows) => ({
                value: undefined,
                postimages: new Map([
                  [
                    child.runId,
                    {
                      ...expectDefined(rows.get(child.runId), "committed delivery owner"),
                      generation: 2,
                    },
                  ],
                ]),
              }));
              successor = subagentRuns.get(child.runId);
              return;
            }
            // The first continuation performs the existing pre-import guard. The
            // second advances ownership while that actual import is pending.
            queueMicrotask(() =>
              queueMicrotask(() => {
                vi.stubEnv("OPENCLAW_STATE_DIR", replacementRoot);
              }),
            );
          },
        );
      }
      const recover = async () => {
        const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const startServices = () =>
          activateGatewayScheduledServices({
            scheduler,
            minimalTestGateway: false,
            cfgAtStart: cfg,
            deps: {},
            sessionDeliveryRecoveryMaxEnqueuedAt: queued.enqueuedAt,
            log: { ...log, child: () => log },
          });
        let services = startServices();
        try {
          await clock.advanceBy(1_250);
          await services.stopDeliveryRecovery();
          await cleanupRelease;
          expect(settled).toHaveBeenCalledOnce();
          expect(deliver).not.toHaveBeenCalled();
          if (change === "hydration pending") {
            expect(subagentRuns.has(child.runId)).toBe(false);
            expect(readSubagentRun(database, child.runId)?.delivery?.status).toBe("in_progress");
            expect(await loadPendingSessionDelivery(queueId, context)).toMatchObject({
              settlementOutcome: "recovered",
            });
            expect(resume).not.toHaveBeenCalled();
            expect(await restoreSubagentRunsFromDisk({ runs: subagentRuns, mergeOnly: true })).toBe(
              1,
            );
            await services.stopScheduledServices();
            services = startServices();
            await clock.advanceBy(1_250);
            await services.stopDeliveryRecovery();
            expect(settled).toHaveBeenCalledTimes(2);
            expect(readSubagentRun(database, child.runId)?.delivery?.status).toBe("delivered");
            expect(
              getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, queueId, state.stateDir),
            ).toBe("completed");
            expect(resume).toHaveBeenCalledExactlyOnceWith(child.runId);
            expect(deliver).not.toHaveBeenCalled();
          } else if (change === "default after commit") {
            const committed = readSubagentRun(database, child.runId);
            expect(committed?.delivery?.status).toBe("delivered");
            expect(resume).not.toHaveBeenCalled();
            expect(await loadPendingSessionDelivery(queueId, context)).toMatchObject({
              settlementOutcome: "recovered",
            });
            if (replacement) {
              expect(readSubagentRun(replacement, child.runId)).toEqual(replacementBefore);
            }
            database.db.exec(
              "CREATE TRIGGER reject_settlement_rewrite BEFORE UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'must reconcile committed delivery without rewriting'); END",
            );
            vi.unstubAllEnvs();
            // Reconstitute the live owner through canonical restoration, without a receipt closure.
            expect(await restoreSubagentRunsFromDisk({ runs: subagentRuns })).toBe(1);
            await services.stopScheduledServices();
            services = startServices();
            await clock.advanceBy(1_250);
            await services.stopDeliveryRecovery();
            expect(settled).toHaveBeenCalledTimes(2);
            expect(readSubagentRun(database, child.runId)).toEqual(committed);
            expect(
              getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, queueId, state.stateDir),
            ).toBe("completed");
            expect(resume).toHaveBeenCalledExactlyOnceWith(child.runId);
            expect(deliver).not.toHaveBeenCalled();
          } else if (replacingSource) {
            const target =
              change === "file" ? openOpenClawStateDatabase({ path: database.path }) : replacement!;
            expect(readSubagentRun(target, child.runId)).toEqual(replacementBefore);
            expect(subagentRuns.get(child.runId)).toBe(child);
            expect(child).toEqual(before);
            expect(resume).not.toHaveBeenCalled();
            expect(log.error).toHaveBeenCalledWith(
              expect.stringContaining("settled callback failed"),
            );
            if (change === "default") {
              expect(await loadPendingSessionDelivery(queueId, context)).toMatchObject({
                settlementOutcome: outcome,
              });
              expect(readSubagentRun(database, child.runId)?.delivery?.status).toBe("in_progress");
            }
          } else {
            expect(readSubagentRun(database, child.runId)?.delivery?.status).toBe(
              outcome === "recovered" ? "delivered" : "suspended",
            );
            expect(
              getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, queueId, state.stateDir),
            ).toBe(outcome === "recovered" ? "completed" : "failed");
            if (change === "cleanup released at receipt") {
              expect(readSubagentRun(database, child.runId)?.cleanupHandled).toBe(false);
              expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("delivered");
            }
            if (change === "successor") {
              expect(successor).toBeDefined();
              expect(subagentRuns.get(child.runId)).toBe(successor);
              expect(resume).not.toHaveBeenCalled();
            } else if (outcome === "recovered") {
              expect(resume).toHaveBeenCalledWith(child.runId);
            } else {
              expect(resume).not.toHaveBeenCalled();
            }
          }
        } finally {
          await services.stopDeliveryRecovery();
          await services.stopScheduledServices();
          await scheduler.stop();
          subagentRuns.delete(child.runId);
          vi.unstubAllEnvs();
          if (replacement) {
            await closeOpenClawStateDatabaseByPathAsync(replacement.path);
          }
        }
      };
      await recover();
    });
  });
});
