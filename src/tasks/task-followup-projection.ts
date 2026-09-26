import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../agents/agent-run-terminal-outcome.js";
import type {
  FollowupCompletionOwner,
  FollowupReply,
} from "../agents/subagents/completion/session-followup-completion.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CreatedDetachedTaskRun } from "./detached-task-runtime-contract.js";
import { captureTaskCancellationControl } from "./task-cancellation-context.js";
import { mapAgentRunTerminalOutcomeToTaskStatus } from "./task-registry-common.js";
import type { TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";
import type { TaskRunOwnerBinding } from "./task-run-owner.types.js";

type FollowupTaskProjection = {
  receipt: CreatedDetachedTaskRun;
  binding: TaskRunOwnerBinding;
  terminal?: Readonly<TaskRecord>;
};
const projections = resolveGlobalSingleton(
  Symbol.for("openclaw.tasks.followupProjections"),
  () => new WeakMap<FollowupCompletionOwner, FollowupTaskProjection>(),
);

export function getFollowupTaskProjection(owner: FollowupCompletionOwner): CreatedDetachedTaskRun {
  const projection = projections.get(owner);
  if (!projection) {
    throw new Error("Followup Task projection is unavailable.");
  }
  return projection.receipt;
}

function readProjection(owner: FollowupCompletionOwner) {
  const projection = projections.get(owner);
  if (!projection || getTaskRunOwner(projection.receipt.task) !== projection.binding.owner) {
    throw new Error("Followup Task projection was replaced.");
  }
  const task = projection.binding.owner.readCurrent?.();
  if (!task) {
    throw new Error("Followup Task projection has no live receipt.");
  }
  return { projection, task };
}

/** Tasks retains only its row/cancel projection; logical custody belongs to the session owner. */
export async function bindFollowupTaskProjection(
  owner: FollowupCompletionOwner,
  receipt: CreatedDetachedTaskRun,
  assertAdmissionCurrent: () => void,
): Promise<void> {
  let cancelling: Promise<Result<TaskRecord, string>> | undefined;
  const binding = await receipt.bindRunOwner(
    (reason) => {
      const control = captureTaskCancellationControl();
      const assertCallerCurrent = () => {
        control?.assertCurrent();
        readProjection(owner);
      };
      try {
        assertCallerCurrent();
      } catch (error) {
        return Promise.resolve(err(formatErrorMessage(error)));
      }
      if (cancelling) {
        return cancelling;
      }
      // Admit the join before stopping work; projection acknowledgment still owns this API result.
      const completion = createDeferredCore<Result<TaskRecord, string>>();
      const pending = completion.promise;
      cancelling = pending;
      const cancel = async (): Promise<Result<TaskRecord, string>> => {
        try {
          const admittedProjection = readProjection(owner).projection;
          const cancelled = await owner.cancel(reason, assertCallerCurrent);
          if (!cancelled.ok) {
            return cancelled;
          }
          if (cancelled.value.kind === "terminal") {
            try {
              await projectFollowupTaskTerminal(
                owner,
                cancelled.value.reply,
                cancelled.value.assertCurrent,
              );
              owner.finishExecution(cancelled.value.runId);
            } catch (error) {
              owner.close(error);
              throw error;
            }
          }
          const current = admittedProjection.terminal;
          return current?.status === "cancelled"
            ? ok({ ...current })
            : err("Followup cancellation was not confirmed. Inspect its final result.");
        } catch (error) {
          return err(formatErrorMessage(error));
        }
      };
      void cancel().then(completion.resolve, completion.reject);
      const releaseJoin = () => {
        if (cancelling === pending) {
          cancelling = undefined;
        }
      };
      void pending.then(releaseJoin, releaseJoin);
      return pending;
    },
    () => {
      owner.assertCurrent();
      assertAdmissionCurrent();
    },
  );
  const projection = { receipt, binding };
  projections.set(owner, projection);
  const release = () => {
    if (projections.get(owner) === projection) {
      projections.delete(owner);
    }
    binding.release();
  };
  owner.signal.addEventListener("abort", release, { once: true });
  if (owner.signal.aborted) {
    release();
  }
  owner.assertCurrent();
}

export async function resumeFollowupTaskProjection(
  owner: FollowupCompletionOwner,
  runId: string,
  assertExecutionCurrent: () => void,
): Promise<void> {
  if (runId === owner.request.runId) {
    return;
  }
  const { projection } = readProjection(owner);
  const resume = projection.binding.owner.resumeExecution;
  if (!resume) {
    throw new Error("Followup Task projection cannot resume its execution.");
  }
  await resume(assertExecutionCurrent);
  assertExecutionCurrent();
}

export async function projectFollowupTaskTerminal(
  owner: FollowupCompletionOwner,
  reply: FollowupReply,
  assertExecutionCurrent: () => void,
): Promise<void> {
  owner.assertCurrent();
  const { projection } = readProjection(owner);
  const outcome = buildAgentRunTerminalOutcomeFromWaitResult(reply);
  if (!outcome) {
    throw new Error("Followup projection has no terminal outcome.");
  }
  const status = mapAgentRunTerminalOutcomeToTaskStatus(outcome);
  await projection.receipt.finalizeActive(
    {
      status,
      endedAt: reply.endedAt ?? Date.now(),
      error: reply.error,
      terminalSummary: reply.error ?? "completed",
    },
    () => {
      owner.assertCurrent();
      readProjection(owner);
      assertExecutionCurrent();
      return true;
    },
  );
  owner.assertCurrent();
  const committed = readProjection(owner).task;
  if (committed.status !== status) {
    throw new Error("Followup terminal projection was not committed.");
  }
  projection.terminal = { ...committed };
}
