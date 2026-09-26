/** Same-process custody for a followup's result across committed yield cohorts. */
import { AsyncLocalStorage } from "node:async_hooks";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../agents/agent-run-terminal-outcome.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CreatedDetachedTaskRun } from "./detached-task-runtime-contract.js";
import { captureTaskCancellationControl } from "./task-cancellation-context.js";
import { cancelFollowupCohort } from "./task-followup-cancellation.js";
import { getFollowupCohortOwner, bindFollowupCohortOwner } from "./task-followup-cohort.js";
import type {
  FollowupCohort as Cohort,
  FollowupCompletionOwner,
  FollowupReply,
  FollowupRequest,
  FollowupSuccessor,
} from "./task-followup-completion.types.js";
import { mapAgentRunTerminalOutcomeToTaskStatus } from "./task-registry-common.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";
import type { TaskRunOwnerBinding, TaskRunOwner } from "./task-run-owner.types.js";

const state = resolveGlobalSingleton(Symbol.for("openclaw.tasks.followupCompletion"), () => ({
  requests: new AsyncLocalStorage<FollowupRequest>(),
  successors: new AsyncLocalStorage<FollowupSuccessor>(),
  // These are indexes of the existing task owner, never independent run/task rows.
  executions: new Map<string, TaskFollowupCompletion>(),
}));
export function withFollowupRequest<T>(request: FollowupRequest, run: () => T): T {
  return state.requests.run(request, run);
}
export function readFollowupRequest(runId: string, targetSessionKey: string) {
  const request = state.requests.getStore();
  return request?.runId === runId && request.targetSessionKey === targetSessionKey
    ? request
    : undefined;
}
export function readFollowupSuccessor(runId: string, targetSessionKey: string) {
  const successor = state.successors.getStore();
  return successor?.runId === runId && successor.owner.request.targetSessionKey === targetSessionKey
    ? successor
    : undefined;
}

/** A weak cohort tombstone must survive revocation: missing authority is not System authority. */
export function getFollowupForCohort(entries: readonly SubagentRunRecord[]) {
  const owner = entries.length ? getFollowupCohortOwner(entries[0]!) : undefined;
  return owner && entries.every((entry) => getFollowupCohortOwner(entry) === owner)
    ? owner
    : undefined;
}
export function promoteFollowupYield(params: {
  requesterTurnRunId: string;
  entries: readonly SubagentRunRecord[];
  rearmGeneration: number | undefined;
}) {
  if (params.rearmGeneration === undefined) {
    return;
  }
  state.executions
    .get(params.requesterTurnRunId)
    ?.promoteYield(params.requesterTurnRunId, params.entries, params.rearmGeneration);
}
export function withFollowupSuccessor<T>(successor: FollowupSuccessor, run: () => T): T {
  successor.assertCurrent();
  return successor.owner.request.custody.run(() => state.successors.run(successor, run));
}

export class TaskFollowupCompletion implements FollowupCompletionOwner {
  readonly request: FollowupRequest;
  readonly receipt: CreatedDetachedTaskRun;
  private binding?: TaskRunOwnerBinding;
  private execution: {
    runId: string;
    settled: Deferred;
    yielded: boolean;
    cancel?: TaskRunOwner["cancel"];
    admittedCohort?: Cohort;
  };
  private cohort?: Cohort;
  private readonly result = createDeferredCore<FollowupReply>();
  private terminal?: Promise<FollowupReply>;
  private acceptedExecution = false;
  private cancellationRequested = false;
  private cancelling?: Promise<Result<TaskRecord, string>>;
  private closed = false;
  private taking = false;
  private consumed = false;
  private readonly revoked: () => void;

  private constructor(request: FollowupRequest, receipt: CreatedDetachedTaskRun) {
    this.request = request;
    this.receipt = receipt;
    this.execution = { runId: request.runId, settled: createDeferredCore(), yielded: false };
    this.revoked = () => this.close(new Error("Followup completion authority was revoked."));
    void this.result.promise.catch(() => {});
  }

  static async bind(
    request: FollowupRequest,
    receipt: CreatedDetachedTaskRun,
    assertAdmissionCurrent?: () => void,
  ) {
    request.custody.assertCurrent();
    const owner = new TaskFollowupCompletion(request, receipt);
    const binding = await receipt.bindRunOwner(
      (reason) => owner.execution.cancel?.(reason) ?? owner.cancelYielded(reason),
      () => {
        request.custody.assertCurrent();
        assertAdmissionCurrent?.();
      },
    );
    owner.binding = binding;
    request.completion = owner;
    state.executions.set(request.runId, owner);
    request.custody.signal.addEventListener("abort", owner.revoked, { once: true });
    if (request.custody.signal.aborted) {
      owner.revoked();
    }
    try {
      owner.assertCurrent();
      return owner;
    } catch (error) {
      owner.close(error);
      throw error;
    }
  }

  assertCurrent() {
    if (this.closed || !this.binding || getTaskRunOwner(this.receipt.task) !== this.binding.owner) {
      throw new Error("Followup task completion owner was replaced or closed.");
    }
    if (!this.binding.owner.readCurrent) {
      throw new Error("Followup task receipt has no live custody.");
    }
    this.binding.owner.readCurrent();
    this.request.custody.assertCurrent();
  }
  get accepted() {
    return this.acceptedExecution;
  }
  markAccepted(runId: string) {
    this.assertCurrent();
    if (!this.ownsExecution(runId)) {
      throw new Error("Followup acceptance belongs to another execution.");
    }
    this.acceptedExecution = true;
  }
  finishExecution(runId: string) {
    if (!this.ownsExecution(runId)) {
      return;
    }
    this.execution.settled.resolve();
    void this.terminal?.then(this.result.resolve, this.result.reject);
  }
  ownsExecution(runId: string) {
    return !this.closed && this.execution.runId === runId;
  }
  async activate(
    runId: string,
    cancel: TaskRunOwner["cancel"] | undefined,
    assertPhysicalCurrent: () => void,
  ) {
    const execution = this.execution;
    const assertCurrent = () => {
      this.assertCurrent();
      assertPhysicalCurrent();
      if (
        this.execution !== execution ||
        execution.runId !== runId ||
        execution.yielded ||
        this.terminal ||
        !this.acceptedExecution
      ) {
        throw new Error("Followup no longer owns this accepted execution.");
      }
    };
    assertCurrent();
    execution.cancel = cancel;
    const release = () => {
      execution.cancel = undefined;
    };
    try {
      if (execution.admittedCohort) {
        const resume = this.binding?.owner.resumeExecution;
        if (!resume) {
          throw new Error("Followup receipt cannot activate a successor.");
        }
        await resume(assertCurrent);
        assertCurrent();
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  promoteYield(runId: string, entries: readonly SubagentRunRecord[], generation: number) {
    this.assertCurrent();
    if (
      this.execution.runId !== runId ||
      this.terminal ||
      entries.length === 0 ||
      entries.some(
        (entry) =>
          entry.requesterSessionKey !== this.request.targetSessionKey ||
          entry.requesterSettleWake?.rearmGeneration !== generation ||
          entry.requesterSettleWake.requesterYieldBatch !== true,
      )
    ) {
      throw new Error("Followup yield does not own the committed completion cohort.");
    }
    this.cohort = { entries: [...entries], generation };
    for (const entry of entries) {
      bindFollowupCohortOwner(entry, this);
    }
  }
  successor(
    entries: readonly SubagentRunRecord[],
    runId: string,
    assertBatchCurrent: () => void,
  ): FollowupSuccessor {
    const cohort =
      this.cohort ?? (this.execution.runId === runId ? this.execution.admittedCohort : undefined);
    if (this.cancellationRequested) {
      throw new Error("Followup cancellation owns this continuation.");
    }
    if (
      !cohort ||
      cohort.entries.length !== entries.length ||
      !entries.every((entry) => cohort.entries.includes(entry))
    ) {
      throw new Error("Followup completion cohort was replaced.");
    }
    const assertCurrent = () => {
      this.assertCurrent();
      assertBatchCurrent();
      if (
        this.cancellationRequested ||
        (this.cohort !== cohort &&
          !(this.execution.runId === runId && this.execution.admittedCohort === cohort)) ||
        entries.some(
          (entry) =>
            getFollowupCohortOwner(entry) !== this ||
            entry.requesterSettleWake?.rearmGeneration !== cohort.generation ||
            entry.killIntent ||
            entry.killReconciliation ||
            entry.suppressCompletionDelivery,
        )
      ) {
        throw new Error("Followup successor no longer owns its completion cohort.");
      }
    };
    assertCurrent();
    return { owner: this, cohort, runId, assertCurrent };
  }
  async prepareSuccessor(successor: FollowupSuccessor) {
    successor.assertCurrent();
    await this.execution.settled.promise;
    successor.assertCurrent();
    if (!this.execution.yielded || this.terminal) {
      throw new Error("Followup predecessor did not yield.");
    }
  }
  adopt(successor: FollowupSuccessor) {
    successor.assertCurrent();
    if (!this.execution.yielded || this.terminal) {
      throw new Error("Followup predecessor is not paused.");
    }
    if (this.cancellationRequested || this.cohort !== successor.cohort) {
      throw new Error("Followup handoff no longer permits a new execution.");
    }
    state.executions.delete(this.execution.runId);
    this.execution = {
      runId: successor.runId,
      settled: createDeferredCore(),
      yielded: false,
      admittedCohort: successor.cohort,
    };
    this.cohort = undefined;
    this.acceptedExecution = false;
    state.executions.set(successor.runId, this);
  }
  async settle(runId: string, reply: FollowupReply, assertExecutionCurrent?: () => void) {
    this.assertCurrent();
    assertExecutionCurrent?.();
    if (this.execution.runId !== runId) {
      throw new Error("Followup terminal execution was replaced.");
    }
    if (reply.status === "ok" && reply.yielded && this.cohort) {
      this.execution.yielded = true;
      return;
    }
    const result: FollowupReply =
      reply.status === "ok" && reply.yielded
        ? { status: "error", error: "Followup yielded without a committed completion handoff." }
        : reply;
    const terminalOutcome = buildAgentRunTerminalOutcomeFromWaitResult(result);
    if (!terminalOutcome) {
      throw new Error("Followup execution has no terminal outcome.");
    }
    const terminalStatus = mapAgentRunTerminalOutcomeToTaskStatus(terminalOutcome);
    this.terminal ??= (async () => {
      await this.receipt.finalizeActive(
        {
          status: terminalStatus,
          endedAt: result.endedAt ?? Date.now(),
          error: result.error,
          terminalSummary: result.error ?? "completed",
        },
        () => {
          this.assertCurrent();
          assertExecutionCurrent?.();
          return this.execution.runId === runId;
        },
      );
      this.assertCurrent();
      const committed = this.binding?.owner.readCurrent?.();
      if (!committed || committed.status !== terminalStatus) {
        throw new Error("Followup terminal result was not committed by its task owner.");
      }
      return result;
    })();
    try {
      await this.terminal;
    } catch (error) {
      this.close(error);
      throw error;
    }
  }
  /** A timeout transfers observation, not result consumption. No second observer is launched. */
  async take(timeoutMs?: number): Promise<FollowupReply | undefined> {
    this.assertCurrent();
    if (this.consumed || this.taking) {
      throw new Error("Followup result already has a consumer.");
    }
    this.taking = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply =
        timeoutMs === undefined
          ? await this.result.promise
          : await Promise.race([
              this.result.promise,
              new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), timeoutMs);
              }),
            ]);
      this.assertCurrent();
      if (reply) {
        this.consumed = true;
      }
      return reply;
    } finally {
      clearTimeout(timer);
      this.taking = false;
    }
  }
  replaceCohortEntry(previous: SubagentRunRecord, next: SubagentRunRecord): () => void {
    const cohorts = [this.cohort, this.execution.admittedCohort].filter(
      (cohort): cohort is Cohort => Boolean(cohort?.entries.includes(previous)),
    );
    if (
      (previous.taskRunId ?? previous.runId) !== (next.taskRunId ?? next.runId) ||
      previous.childSessionKey !== next.childSessionKey ||
      previous.requesterSessionKey !== next.requesterSessionKey ||
      previous.requesterAgentId !== next.requesterAgentId ||
      !next.requesterSettleWake
    ) {
      return () => {};
    }
    const changes = cohorts.map((cohort) => {
      const before = cohort.entries;
      const after = before.map((entry) => (entry === previous ? next : entry));
      cohort.entries = after;
      return { cohort, before, after };
    });
    return () => {
      for (const { cohort, before, after } of changes) {
        if (cohort.entries === after) {
          cohort.entries = before;
        }
      }
    };
  }
  private cancelYielded(reason: string): Promise<Result<TaskRecord, string>> {
    if (this.cancelling) {
      return this.cancelling;
    }
    const execution = this.execution;
    const cohort = this.cohort;
    if (!execution.yielded || !cohort || this.terminal) {
      return Promise.resolve(err("Followup has no cancellable paused execution."));
    }
    const control = captureTaskCancellationControl();
    const entries = [...cohort.entries];
    const assertCurrent = () => {
      control?.assertCurrent();
      this.assertCurrent();
      if (
        this.execution !== execution ||
        this.cohort !== cohort ||
        entries.length !== cohort.entries.length ||
        !entries.every((entry) => cohort.entries.includes(entry))
      ) {
        throw new Error("Followup cohort changed while cancellation was in progress.");
      }
    };
    try {
      assertCurrent();
    } catch (error) {
      return Promise.resolve(err(formatErrorMessage(error)));
    }
    this.cancellationRequested = true;
    const cancellation = (async (): Promise<Result<TaskRecord, string>> => {
      try {
        assertCurrent();
        await cancelFollowupCohort({ request: this.request, entries, assertCurrent });
        assertCurrent();
        await this.settle(
          execution.runId,
          { status: "error", stopReason: "rpc", error: reason, endedAt: Date.now() },
          assertCurrent,
        );
        this.finishExecution(execution.runId);
        const task = this.binding?.owner.readCurrent?.();
        if (!task || task.status !== "cancelled") {
          return err("Followup cancellation was not committed.");
        }
        return ok({ ...task });
      } catch (error) {
        return err(formatErrorMessage(error));
      }
    })();
    this.cancelling = cancellation;
    void cancellation.then(() => {
      if (this.cancelling === cancellation) {
        this.cancelling = undefined;
      }
    });
    return cancellation;
  }
  close(error?: unknown) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (state.executions.get(this.execution.runId) === this) {
      state.executions.delete(this.execution.runId);
    }
    this.execution.settled.resolve();
    this.result.reject(error ?? new Error("Followup completion custody ended."));
    this.request.custody.signal.removeEventListener("abort", this.revoked);
    this.binding?.release();
    this.request.custody.release();
  }
}
