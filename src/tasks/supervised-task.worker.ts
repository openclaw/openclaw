import { randomUUID } from "node:crypto";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import {
  consumeSupervisedAttemptSettlement,
  type SupervisedAttemptSettlement,
} from "./supervised-attempt-candidate.js";
import { hasSupervisedAttemptResourceCapacity } from "./supervised-attempt-custody.js";
import { sweepSupervisedAttemptResources } from "./supervised-attempt-recovery.js";
import { startSupervisedOperationDispatcher } from "./supervised-operation.dispatcher.js";
import { enqueueSupervisedOperation } from "./supervised-operation.store.js";
import { SupervisedDecisionFormatError } from "./supervised-task.decision.js";
import {
  assertSupervisedAttemptCurrent,
  claimSupervisedTask,
  failSupervisedAttempt,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  listSupervisedTasks,
  reconcileSupervisedTasks,
  reserveSupervisedDispatch,
  settleSupervisedDecision,
  stopTaskSupervisor,
} from "./supervised-task.store.js";
import {
  SupervisedDecisionSchema,
  type SupervisedDecision,
  type SupervisedTask,
} from "./supervised-task.types.js";
import {
  verifySupervisedWorkflowAcceptance,
  type SupervisedAcceptanceProof,
} from "./supervised-workflow.acceptance.js";
import {
  startSupervisedWorkspaceRetention,
  retireSupervisedWorkspaces,
} from "./supervised-workspace-retention.js";

export type SupervisedAttemptRunner = (
  task: SupervisedTask,
  context: {
    signal: AbortSignal;
    assertCurrent: () => void;
    options?: OpenClawStateDatabaseOptions;
  },
) => Promise<SupervisedDecision | SupervisedAttemptSettlement>;

/**
 * Native continuation owner. Timers are merely triggers: SQL owns ready work,
 * deadlines, claims and endpoints. A new worker reconciles before dispatch.
 */
export function startSupervisedTaskWorker(params: {
  runAttempt: SupervisedAttemptRunner;
  options?: OpenClawStateDatabaseOptions;
  onError: (error: unknown) => void;
  onlyFlowId?: string;
  onChange?: (task: SupervisedTask) => void;
  canObserve?: () => boolean;
  acquireAttempt?: () => {
    run: (operation: () => Promise<void>) => Promise<void>;
    release: () => void;
  } | null;
}) {
  const options = params.options ?? {};
  const ownerId = randomUUID();
  let stopped = false;
  let active: { task: SupervisedTask; controller: AbortController } | undefined;
  let ticking = false;
  let sweepingResources = false;
  let resourceCursor: string | undefined;

  // Observer failures must never change execution or endpoint settlement.
  const reportError = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      /* Observation is not task authority. */
    }
  };
  const reportChange = (task: SupervisedTask) => {
    try {
      params.onChange?.(task);
    } catch (error) {
      reportError(error);
    }
  };

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    operations.stop();
    retention?.stop();
    active?.controller.abort(new Error("Supervised task worker stopped"));
    try {
      stopTaskSupervisor(ownerId, Date.now(), options);
      // Does not wait for a hung backend to admit that it stopped. Its exact
      // source fence has been revoked; any potentially applied effects stay unknown.
      if (active) {
        const endpoint = failSupervisedAttempt(
          active.task,
          "Supervisor stopped during execution; effects require reconciliation",
          Date.now(),
          options,
        );
        if (endpoint) {
          reportChange(endpoint);
        }
      }
    } catch (error) {
      reportError(error);
    }
  };

  const launch = (
    claimed: SupervisedTask,
    admission: NonNullable<ReturnType<NonNullable<typeof params.acquireAttempt>>> | undefined,
  ) => {
    const controller = new AbortController();
    const task = reserveSupervisedDispatch(claimed, Date.now(), options);
    active = { task, controller };
    const assertCurrent = () => {
      if (stopped || controller.signal.aborted) {
        throw new Error("Supervised attempt has been stopped");
      }
      assertSupervisedAttemptCurrent(task, Date.now(), options);
    };
    // Catch synchronous invocation failures as well as async rejection. Do not
    // retry unknown effects, and retain the local slot until runtime cleanup ends.
    const execute = async () => {
      assertCurrent();
      const attemptResult = await params.runAttempt(task, {
        signal: controller.signal,
        assertCurrent,
        options,
      });
      const committed = consumeSupervisedAttemptSettlement(attemptResult, task);
      if (committed) {
        // Candidate owner already committed artifact + decision/operation wait.
        // Task execution authority has ended; do not assert it or settle twice.
        reportChange(committed);
        return;
      }
      let decision = SupervisedDecisionSchema.parse(attemptResult);
      assertCurrent();
      let acceptance: SupervisedAcceptanceProof | undefined;
      if (decision.kind === "succeeded" || decision.kind === "partial") {
        const verified = await verifySupervisedWorkflowAcceptance(task, decision, options);
        assertCurrent();
        if (verified.kind === "verified") {
          acceptance = verified.proof;
        } else if (verified.kind === "check") {
          decision = {
            kind: "operation",
            operation: {
              key: verified.key,
              kind: verified.profile.kind,
              profile: verified.profile.id,
              input: {},
            },
          };
        } else if (verified.kind === "rejected") {
          decision = verified.operatorRequired
            ? {
                kind: "input_required",
                reason: verified.reason,
                question: "Resolve the explicit acceptance requirement before resuming.",
              }
            : { kind: "continue", next: verified.reason };
        }
      }
      if (decision.kind === "operation") {
        enqueueSupervisedOperation(task, decision.operation, Date.now(), options);
        const waiting = getSupervisedTask(task.flowId, options, task.episode);
        if (waiting) {
          reportChange(waiting);
        }
        return;
      }
      const result = settleSupervisedDecision(
        task,
        SupervisedDecisionSchema.parse(decision),
        Date.now(),
        options,
        acceptance,
      );
      reportChange(result);
    };
    void Promise.resolve()
      .then(async () => {
        try {
          await (admission ? admission.run(execute) : execute());
        } catch (error: unknown) {
          try {
            const endpoint = failSupervisedAttempt(
              task,
              error instanceof SupervisedDecisionFormatError
                ? error.message
                : "Attempt failed or returned an invalid task decision; inspect the attempt before resuming",
              Date.now(),
              options,
              error instanceof SupervisedDecisionFormatError ? "invalid_decision" : undefined,
            );
            if (endpoint) {
              reportChange(endpoint);
            }
          } catch (storeError) {
            reportError(storeError);
            stop();
          }
          reportError(error);
        } finally {
          // Retire only accepted, joined scratch after the decision is durable.
          // Cleanup errors remain observable without rewriting that decision.
          try {
            await retireSupervisedWorkspaces(Date.now(), options);
          } catch (error) {
            reportError(error);
          }
          admission?.release();
          if (active?.task.attempt?.id === task.attempt?.id) {
            active = undefined;
          }
        }
      })
      .catch(reportError);
  };

  const tick = () => {
    if (stopped || ticking) {
      return;
    }
    ticking = true;
    try {
      // Previously admitted work may settle during refuse-only suspension. Idle
      // workers neither mutate state nor accept new attempts while admission is closed.
      if (!active && params.canObserve?.() === false) {
        return;
      }
      const now = Date.now();
      heartbeatTaskSupervisor(ownerId, now, 10_000, options, params.onlyFlowId);
      if (!sweepingResources) {
        sweepingResources = true;
        void sweepSupervisedAttemptResources({
          supervisorId: ownerId,
          options,
          onlyFlowId: params.onlyFlowId,
          afterResourceId: resourceCursor,
          onError: reportError,
          assertCleanupCurrent: () => {
            if (stopped) {
              throw new Error("Supervisor cleanup ownership stopped");
            }
          },
        })
          .then((result) => {
            resourceCursor = result.nextResourceId;
          })
          .catch(reportError)
          .finally(() => {
            sweepingResources = false;
          });
      }
      reconcileSupervisedTasks(now, options);
      if (active) {
        try {
          assertSupervisedAttemptCurrent(active.task, now, options);
        } catch {
          active.controller.abort(new Error("Supervised attempt ownership ended"));
        }
        return;
      }
      for (const task of listSupervisedTasks(options, true)) {
        if (
          (params.onlyFlowId && task.flowId !== params.onlyFlowId) ||
          task.phase === "running" ||
          task.dueAt > now ||
          !hasSupervisedAttemptResourceCapacity(task.flowId, options)
        ) {
          continue;
        }
        const admission = params.acquireAttempt?.();
        if (admission === null) {
          break;
        }
        let launched = false;
        try {
          // Root admission, SQL claim and dispatch reservation have no await
          // between them. A closed Gateway cannot consume an attempt budget.
          const claimed = claimSupervisedTask(task.flowId, ownerId, now, options);
          if (claimed?.phase === "running") {
            launch(claimed, admission);
            launched = true;
            break;
          }
          if (claimed) {
            reportChange(claimed);
          }
        } catch (error) {
          reportError(error);
        } finally {
          if (!launched) {
            admission?.release();
          }
        }
      }
    } catch (error) {
      reportError(error);
      stop();
    } finally {
      ticking = false;
    }
  };

  // Admission can only use this worker after its first durable heartbeat.
  heartbeatTaskSupervisor(ownerId, Date.now(), 10_000, options, params.onlyFlowId);
  const operations = startSupervisedOperationDispatcher({
    options,
    onlyFlowId: params.onlyFlowId,
    canDispatch: params.canObserve,
    onError: reportError,
  });
  const retention = params.onlyFlowId
    ? undefined
    : startSupervisedWorkspaceRetention(options, reportError);
  const timer = setInterval(tick, 1000);
  tick();
  return {
    ownerId,
    stop,
    get stopped() {
      return stopped;
    },
  };
}
