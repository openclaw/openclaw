// Windows Scheduled Task autostart suspension and restore around a mutable update.
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import { finishUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import { UpdateCommandAbort, type UpdateCommandOptions } from "./shared.js";

export type WindowsTaskAutoStartRecovery = {
  beginMutation: () => void;
  restore: (restartSafe?: boolean) => Promise<void>;
  complete: (restartSafe?: boolean) => void;
  interrupted: () => boolean;
};

export async function maybeSuspendWindowsTaskAutoStartForUpdate(params: {
  serviceEnv: NodeJS.ProcessEnv | undefined;
  assertCurrentService?: () => Promise<void>;
  updateRun?: UpdateCommandOptions["run"];
}): Promise<WindowsTaskAutoStartRecovery | undefined> {
  const { serviceEnv, assertCurrentService, updateRun } = params;
  if (process.platform !== "win32" || !serviceEnv) {
    return undefined;
  }
  let restorePromise: Promise<void> | undefined;
  let restorationFailed = false;
  let restoreAllowed = true;
  let unregisterSignalExitBarrier = () => {};
  let finishUpdate: (() => void) | undefined;
  let interrupted = false;
  const updateFinished = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  const unregisterSignalExitGate = registerSignalExitGate(updateFinished);
  // Cancellation can restore the task before mutation. Once lifecycle work
  // starts, only an explicit safe result may re-enable persistent autostart.
  const onSignal = (exitCode: number) => {
    interrupted = true;
    void waitForSignalExitBarriers()
      .catch((err: unknown) => {
        defaultRuntime.error(`Failed to complete update shutdown cleanup: ${String(err)}`);
      })
      .finally(() => {
        process.exit(exitCode);
      });
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  const onSigbreak = () => onSignal(130);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGBREAK", onSigbreak);
    unregisterSignalExitBarrier();
  };
  const complete = (restartSafe = true) => {
    try {
      // Native preparation may abort before returning its recovery handle.
      // Persist that outcome before releasing the signal's process-exit gate.
      if (finishUpdate && interrupted && updateRun && (restoreAllowed || restorationFailed)) {
        const failed = restorationFailed || !restartSafe;
        finishUpdateRun(
          updateRun.runId,
          {
            status: failed ? "failed" : "skipped",
            reason: restorationFailed
              ? "windows-task-autostart-restore-failed"
              : failed
                ? "update-failed"
                : "cancelled",
          },
          { env: updateRun.env },
        );
      }
    } finally {
      if (!restartSafe) {
        // Re-enabling a rejected installation would let a login trigger bypass
        // the updater's unsafe-stop decision after this process has exited.
        restoreAllowed = false;
        removeSignalHandlers();
      }
      finishUpdate?.();
      finishUpdate = undefined;
      unregisterSignalExitGate();
    }
  };
  const restore = (restartSafe?: boolean) => {
    // Finalization has already reported this lifecycle's outcome. A retained
    // cleanup handle cannot reopen it or replay its settled restoration error.
    if (!finishUpdate) {
      return Promise.resolve();
    }
    if (restartSafe === true) {
      restoreAllowed = true;
    }
    restorePromise ??= suspensionPromise
      .then(async (suspended) => {
        if (suspended && restoreAllowed) {
          // Enabling a replaced task would activate an owner this operation never
          // stopped. Revalidate even on failure and signal recovery paths.
          await assertCurrentService?.();
          await resumeScheduledTaskAutoStartAfterUpdate(serviceEnv);
        }
      })
      .catch((error: unknown) => {
        restorationFailed = true;
        throw error;
      })
      .finally(removeSignalHandlers);
    return restorePromise;
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGBREAK", onSigbreak);
  unregisterSignalExitBarrier = registerSignalExitBarrier(restore);
  // Arm recovery before starting the persistent state change. A signal arriving
  // while schtasks is still returning waits for that result before restoring.
  const suspensionPromise = suspendScheduledTaskAutoStartForUpdate(serviceEnv);
  const recovery: WindowsTaskAutoStartRecovery = {
    beginMutation: () => {
      // Async preflight may outlive a signal or settled recovery. Admit mutation
      // only while this owner can still keep native autostart suspended.
      if (interrupted || !finishUpdate) {
        throw new UpdateCommandAbort();
      }
      restoreAllowed = false;
    },
    restore,
    complete,
    interrupted: () => interrupted,
  };
  let suspended: boolean;
  try {
    suspended = await suspensionPromise;
  } catch (err) {
    await recovery.restore().catch(() => undefined);
    recovery.complete(!(err instanceof ScheduledTaskAutoStartRecoveryError));
    throw err;
  }
  await abortWindowsTaskUpdateIfInterrupted(recovery);
  if (!suspended) {
    try {
      await recovery.restore();
    } finally {
      recovery.complete();
    }
    return undefined;
  }
  return recovery;
}

export async function abortWindowsTaskUpdateIfInterrupted(
  recovery: WindowsTaskAutoStartRecovery,
): Promise<void> {
  if (!recovery.interrupted()) {
    return;
  }
  try {
    await recovery.restore();
  } finally {
    recovery.complete();
  }
  throw new UpdateCommandAbort();
}
