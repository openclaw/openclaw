/** Detached managed-update state machine. */

export type UpdateConfirmationTier = "delivery" | "human";

export type UpdateHandoverPhase =
  | "verify"
  | "snapshot"
  | "swap"
  | "restart"
  | "healthy"
  | "confirm"
  | "complete"
  | "rolling-back"
  | "rolled-back"
  | "failed";

export type UpdateHandoverState = {
  phase: UpdateHandoverPhase;
  confirmationTier: UpdateConfirmationTier;
  failureReason?: string;
};

export type UpdateHandoverOperations = {
  verifyNewPackage: () => Promise<boolean>;
  snapshotState: () => Promise<void>;
  swapPackage: () => Promise<void>;
  restartService: () => Promise<void>;
  waitForHealthy: () => Promise<boolean>;
  waitForConfirmation: (tier: UpdateConfirmationTier) => Promise<boolean>;
  cleanupCompleted: () => Promise<void>;
  stopService: () => Promise<void>;
  restorePackage: () => Promise<void>;
  restoreState: () => Promise<void>;
  startService: () => Promise<void>;
  markFailed?: (reason: string) => Promise<void>;
  claimRollback?: (reason: string) => Promise<boolean>;
  onCleanupError?: (error: unknown) => Promise<void> | void;
  onPhase?: (state: UpdateHandoverState) => Promise<void> | void;
};

export type PreparedUpdateHandoverOperations = Pick<
  UpdateHandoverOperations,
  | "restartService"
  | "waitForHealthy"
  | "waitForConfirmation"
  | "cleanupCompleted"
  | "stopService"
  | "restorePackage"
  | "restoreState"
  | "startService"
  | "markFailed"
  | "claimRollback"
  | "onCleanupError"
  | "onPhase"
>;

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackUpdateHandover(params: {
  stopRequired: boolean;
  restoreState: boolean;
  operations: Pick<
    UpdateHandoverOperations,
    "stopService" | "restorePackage" | "restoreState" | "startService"
  >;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  const runRequired = async (operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  };

  // Never replace packages or SQLite files until service shutdown is proven.
  if (params.stopRequired && !(await runRequired(params.operations.stopService))) {
    return errors;
  }
  if (!(await runRequired(params.operations.restorePackage))) {
    return errors;
  }
  if (params.restoreState && !(await runRequired(params.operations.restoreState))) {
    return errors;
  }
  if (params.stopRequired) {
    await runRequired(params.operations.startService);
  }
  return errors;
}

/**
 * Run the update transaction. Full compensation is deliberately serialized:
 * stop service, restore package, restore state, then start the old package.
 */
export async function runUpdateHandover(
  params: UpdateHandoverOperations & { confirmationTier: UpdateConfirmationTier },
): Promise<UpdateHandoverState> {
  let state: UpdateHandoverState = {
    phase: "verify",
    confirmationTier: params.confirmationTier,
  };
  let snapshotCreated = false;
  let swapAttempted = false;
  let restartAttempted = false;

  const transition = async (phase: UpdateHandoverPhase, failureReason?: string) => {
    state = {
      phase,
      confirmationTier: params.confirmationTier,
      ...(failureReason ? { failureReason } : {}),
    };
    await params.onPhase?.(state);
  };
  const transitionBestEffort = async (phase: UpdateHandoverPhase, failureReason?: string) => {
    try {
      await transition(phase, failureReason);
    } catch {
      // Rollback must not depend on status persistence remaining writable.
    }
  };

  let failureReason: string | undefined;
  try {
    await params.onPhase?.(state);
    if (!(await params.verifyNewPackage())) {
      failureReason = "new package startup verification failed";
    } else {
      await transition("snapshot");
      await params.snapshotState();
      snapshotCreated = true;

      await transition("swap");
      swapAttempted = true;
      await params.swapPackage();

      await transition("restart");
      restartAttempted = true;
      await params.restartService();

      if (!(await params.waitForHealthy())) {
        failureReason = "new gateway failed its health check";
      } else {
        await transition("healthy");
        await transition("confirm");
        if (!(await params.waitForConfirmation(params.confirmationTier))) {
          failureReason = `${params.confirmationTier} confirmation timed out`;
        } else {
          // Confirmation is the commit boundary. Finalization may retry, but
          // no persistence or cleanup failure after this point may roll back.
          await transitionBestEffort("complete");
          try {
            await params.cleanupCompleted();
          } catch (error) {
            try {
              await params.onCleanupError?.(error);
            } catch {}
          }
          return state;
        }
      }
    }
  } catch (error) {
    failureReason = failureMessage(error);
  }

  const reason = failureReason ?? "update transaction failed";
  if (params.claimRollback && !(await params.claimRollback(reason))) {
    throw new Error("update rollback ownership lost");
  }
  await transitionBestEffort("rolling-back", reason);
  await params.markFailed?.(reason).catch(() => undefined);
  // A verify failure still restores the retained package. This makes a partial
  // package-manager mutation before the probe harmless, while never restarting.
  const rollbackErrors = await rollbackUpdateHandover({
    stopRequired: swapAttempted || restartAttempted,
    restoreState: snapshotCreated,
    operations: params,
  });

  if (rollbackErrors.length > 0) {
    const rollbackReason = `${reason}; rollback failed: ${rollbackErrors
      .map(failureMessage)
      .join("; ")}`;
    await params.markFailed?.(rollbackReason).catch(() => undefined);
    await transitionBestEffort("failed", rollbackReason);
    throw new AggregateError(rollbackErrors, rollbackReason);
  }

  await transitionBestEffort("rolled-back", reason);
  return state;
}

/** Resume the same state machine after verify, snapshot, and swap completed. */
export async function completePreparedUpdateHandover(
  params: PreparedUpdateHandoverOperations & { confirmationTier: UpdateConfirmationTier },
): Promise<UpdateHandoverState> {
  let state: UpdateHandoverState = {
    phase: "restart",
    confirmationTier: params.confirmationTier,
  };
  const transition = async (phase: UpdateHandoverPhase, failureReason?: string) => {
    state = {
      phase,
      confirmationTier: params.confirmationTier,
      ...(failureReason ? { failureReason } : {}),
    };
    await params.onPhase?.(state);
  };
  const transitionBestEffort = async (phase: UpdateHandoverPhase, failureReason?: string) => {
    try {
      await transition(phase, failureReason);
    } catch {
      // Rollback must not depend on status persistence remaining writable.
    }
  };
  let failureReason: string | undefined;
  try {
    await params.onPhase?.(state);
    await params.restartService();
    if (!(await params.waitForHealthy())) {
      failureReason = "new gateway failed its health check";
    } else {
      await transition("healthy");
      await transition("confirm");
      if (!(await params.waitForConfirmation(params.confirmationTier))) {
        failureReason = `${params.confirmationTier} confirmation timed out`;
      } else {
        // Durable confirmation is irrevocable. Complete-marker and snapshot
        // cleanup failures leave the confirmed marker for startup retry.
        await transitionBestEffort("complete");
        try {
          await params.cleanupCompleted();
        } catch (error) {
          try {
            await params.onCleanupError?.(error);
          } catch {}
        }
        return state;
      }
    }
  } catch (error) {
    failureReason = failureMessage(error);
  }

  const reason = failureReason ?? "update transaction failed";
  if (params.claimRollback && !(await params.claimRollback(reason))) {
    throw new Error("update rollback ownership lost");
  }
  await transitionBestEffort("rolling-back", reason);
  await params.markFailed?.(reason).catch(() => undefined);
  const rollbackErrors = await rollbackUpdateHandover({
    stopRequired: true,
    restoreState: true,
    operations: params,
  });
  if (rollbackErrors.length > 0) {
    const rollbackReason = `${reason}; rollback failed: ${rollbackErrors
      .map(failureMessage)
      .join("; ")}`;
    await params.markFailed?.(rollbackReason).catch(() => undefined);
    await transitionBestEffort("failed", rollbackReason);
    throw new AggregateError(rollbackErrors, rollbackReason);
  }
  await transitionBestEffort("rolled-back", reason);
  return state;
}
