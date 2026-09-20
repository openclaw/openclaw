import { formatErrorMessage } from "../../infra/errors.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  createUpdateCommandFailureResult,
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
  mergeWindowsTaskRecoveryFailure,
} from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import type { UpdateCommandRecoveryState } from "./update-command-service-maintenance.js";
import {
  deferUpdateCommandTerminalResult,
  hasDeferredUpdateCommandTerminalResult,
  prepareUnexpectedUpdateCommandFailure,
} from "./update-command-terminal.js";

/** Unwind only legacy updates; pending publication cannot authorize compensation or diagnostics. */
export async function withUpdateCommandRecoveryUnwind(
  opts: UpdateCommandOptions & { run: NonNullable<UpdateCommandOptions["run"]> },
  recoveryState: UpdateCommandRecoveryState,
  operation: () => Promise<void>,
): Promise<void> {
  const run = opts.run;
  const primaryResult = (error: unknown) =>
    error instanceof UpdateCommandFailure
      ? error.result
      : (recoveryState.triageTarget.failureResult ?? {
          ...createUpdateCommandFailureResult({
            mode: "unknown",
            root: recoveryState.triageTarget.root,
            durationMs: 0,
            failure: {
              cause: error,
              detail: createUpdateErrorFact("update", error, run.env).message,
            },
          }),
          runId: run.runId,
        });
  let failure: { error: unknown } | undefined;
  try {
    await withCommandProcessScope(operation);
    run.executorFence?.assertCurrent();
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw new UpdateCommandPendingRecoveryFailure(
        primaryResult(error),
        formatErrorMessage(error),
        { cause: error },
      );
    }
    try {
      run.executorFence?.assertCurrent();
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(
        primaryResult(error),
        formatErrorMessage(cause),
        { cause: new AggregateError([error, cause], "Update executor was lost", { cause: error }) },
      );
    }
    if (
      error instanceof UpdateCommandPendingRecoveryFailure ||
      error instanceof UpdateCommandFinalizedRecoveryFailure
    ) {
      throw error;
    }
    if (
      error instanceof UpdateCommandRecoveryPendingError ||
      error instanceof UpdateRecoveryRequiredError ||
      opts.recovery
    ) {
      throw new UpdateCommandPendingRecoveryFailure(
        primaryResult(error),
        formatErrorMessage(error),
        { cause: error },
      );
    }
    failure = { error };
  }
  if (opts.recovery) {
    // Durable finalization alone owns native/terminal effects. Never replay
    // legacy compensation, including after an already-finalized failure.
    if (failure) {
      throw failure.error;
    }
    return;
  }
  if (recoveryState.ledgerHandoffOwned && !recoveryState.ledgerHandoffCompleted) {
    let cause = failure?.error ?? new Error("Update finalization has no confirmed outcome.");
    try {
      // Settle the existing guarded suspension without enabling a runtime whose
      // handoff did not finish. The native owner retains its own identity checks.
      await recoveryState.windowsTaskAutoStartRecovery?.complete(false);
    } catch (error) {
      cause = new AggregateError([cause, error], "Migrated handoff recovery remains pending", {
        cause,
      });
    }
    throw new UpdateCommandPendingRecoveryFailure(
      primaryResult(failure?.error ?? cause),
      formatErrorMessage(cause),
      { cause },
    );
  }
  if (!recoveryState.ledgerHandoffOwned) {
    // The admitted newer runtime owns canonical history after handoff. The old
    // process must not reopen a database that it may no longer understand.
    const admitRecovery = async () => {
      // A lost live context or a successful callback is not fresh-install proof.
      // Reconcile all affected state roots read-only before native compensation.
      const paths = new Set<string>();
      for (const env of [run.env, recoveryState.triageTarget.env]) {
        const file = resolveOpenClawStateSqlitePath(env);
        if (paths.has(file)) {
          continue;
        }
        paths.add(file);
        await assertUpdateRecoveryAdmission({ env });
      }
    };
    try {
      await admitRecovery();
    } catch (error) {
      const pending = new UpdateCommandPendingRecoveryFailure(
        primaryResult(failure?.error ?? error),
        formatErrorMessage(error),
        { cause: error },
      );
      if (
        failure &&
        !(failure.error instanceof UpdateCommandFailure) &&
        !run.executorFence &&
        !recoveryState.windowsTaskAutoStartRecovery &&
        !hasDeferredUpdateCommandTerminalResult(run)
      ) {
        const original = failure.error;
        // Pre-staging has no native compensation. Let the terminal owner make
        // one fresh admission after settlement before recording the initial failure.
        deferUpdateCommandTerminalResult(run, async (settlementFailure, onTerminalRecord) => {
          if (settlementFailure !== pending) {
            throw settlementFailure;
          }
          try {
            await admitRecovery();
          } catch (cause) {
            throw new UpdateCommandPendingRecoveryFailure(
              primaryResult(original),
              formatErrorMessage(cause),
              { cause },
            );
          }
          const recorded = await prepareUnexpectedUpdateCommandFailure(
            original,
            opts,
            onTerminalRecord,
          );
          if (recorded instanceof UpdateCommandPendingRecoveryFailure) {
            throw recorded;
          }
          return recorded.result;
        });
      }
      throw pending;
    }
  }
  try {
    await recoveryState.windowsTaskAutoStartRecovery?.restore();
    await recoveryState.windowsTaskAutoStartRecovery?.complete();
  } catch (restoreError) {
    let error = restoreError;
    try {
      await recoveryState.windowsTaskAutoStartRecovery?.complete(false);
    } catch (compensationError) {
      error = new AggregateError(
        [error, compensationError],
        `Windows task autostart recovery failed: ${formatErrorMessage(error)}; ${formatErrorMessage(compensationError)}`,
        { cause: error },
      );
    }
    failure = mergeWindowsTaskRecoveryFailure(failure, error);
  }
  if (failure) {
    if (!recoveryState.ledgerHandoffOwned && !hasDeferredUpdateCommandTerminalResult(run)) {
      if (failure.error instanceof UpdateCommandFailure) {
        completeUpdateCommandRun(failure.error.result, run);
      } else {
        failure.error = await prepareUnexpectedUpdateCommandFailure(failure.error, opts);
      }
    }
    throw failure.error;
  }
}
