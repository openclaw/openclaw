import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import process from "node:process";
import { hasErrnoCode } from "../infra/errno.js";
import { getWindowsSystem32ExePath } from "../infra/windows-install-roots.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { sleep } from "../utils/sleep.js";
import { isChildProcessTreeAliveAsync, isProcessGroupGoneByKernel } from "./child-process-tree.js";
import { readCommandProcessStartTime } from "./command-process-identity.js";
import {
  COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS,
  COMMAND_PROCESS_TREE_KILL_GRACE_MS,
  runOutsideCommandProcessScope,
  spawnCommand,
  waitForCommandProcessGroupExit,
} from "./exec-spawn.js";
import { killProcessTree as terminateProcessTree } from "./kill-tree.js";
import { scheduleAdoptedChildZombieReapAfterExit } from "./scoped-child-reaper.js";

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;

type TerminationChild = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">;

export function createCommandTerminationController(params: {
  child: TerminationChild;
  /** Remote process identity arrives before a pending termination can target its tree. */
  spawned?: Promise<number | null | void>;
  cancelController: AbortController;
  baseEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  processTree?: { mode: "graceful" } | { mode: "force" };
  killGraceMs: number;
  killSignal?: NodeJS.Signals | number;
  isChildExited: () => boolean;
  isCommandSettled: () => boolean;
}): {
  terminate: () => boolean;
  cancel: () => void;
  settle: () => Promise<"normal" | "cooperative" | "forced" | "uncertain">;
} {
  let processTreeSettlement: Promise<void> | undefined;
  let cleanup: "normal" | "cooperative" | "forced" | "uncertain" = "normal";
  const readOriginalStart = () =>
    params.processTree && params.child.pid && process.platform !== "win32"
      ? readCommandProcessStartTime(params.child.pid, { child: params.child })
      : null;
  const preparation =
    params.spawned ??
    ((process.platform === "linux" || process.platform === "android") && params.processTree
      ? Promise.resolve(undefined)
      : undefined);
  let awaitingSpawn = preparation !== undefined;
  let terminateWhenSpawned = false;
  let originalStart: number | null = null;
  if (!preparation && params.processTree && params.child.pid && process.platform !== "win32") {
    originalStart = getFileLockProcessStartTime(params.child.pid);
  }
  let identityReady: Promise<void> | undefined;
  let windowsTerminationPromise: Promise<void> | undefined;

  const isDirectChildAlive = () =>
    !params.isChildExited() && params.child.exitCode == null && params.child.signalCode == null;
  const spawnTaskkill = async (args: string[]) => {
    try {
      await runOutsideCommandProcessScope(() =>
        spawnCommand([getWindowsSystem32ExePath("taskkill.exe"), ...args], {
          baseEnv: params.baseEnv,
          env: params.env,
          forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
          reject: false,
          stdio: "ignore",
          timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
        }),
      );
    } catch {
      // Best-effort Windows cleanup still joins every attempted helper.
    }
  };
  const startWindowsTermination = (childPid: number, graceful: boolean): void => {
    const taskkills: Promise<unknown>[] = [];
    windowsTerminationPromise = (async () => {
      if (graceful) {
        taskkills.push(spawnTaskkill(["/PID", String(childPid), "/T"]));
        // Awaited cleanup stays live after both the child and taskkill handles close.
        await sleep(params.killGraceMs);
        if (isDirectChildAlive()) {
          taskkills.push(spawnTaskkill(["/PID", String(childPid), "/T", "/F"]));
        }
      } else {
        taskkills.push(spawnTaskkill(["/PID", String(childPid), "/T", "/F"]));
      }
      // Failed helpers still join here before root cancellation; a sibling taskkill
      // may still be enumerating descendants through that live PID.
      await Promise.allSettled(taskkills);
      if (!params.isCommandSettled()) {
        params.cancelController.abort();
      }
    })();
  };

  const terminate = (): boolean => {
    if (awaitingSpawn) {
      terminateWhenSpawned = true;
      // The live direct handle still authorizes graceful cancellation during birth preparation.
      if (params.child.pid === undefined || !isDirectChildAlive()) {
        return false;
      }
    }
    const childPid = params.child.pid;
    const directChildAlive = isDirectChildAlive();
    if (process.platform === "win32" && !directChildAlive) {
      // taskkill /T requires a live root PID. Retrying a dead, reusable PID can
      // target an unrelated tree; stronger ownership requires a spawn-time Job Object.
      return false;
    }
    if (params.processTree && typeof childPid === "number") {
      if (process.platform === "win32") {
        startWindowsTermination(childPid, params.processTree.mode !== "force");
        return true;
      }
      const force =
        params.processTree.mode === "force" ||
        params.killSignal === "SIGKILL" ||
        params.killSignal === osConstants.signals.SIGKILL;
      if (processTreeSettlement) {
        return !force;
      }
      const groupAlive = () => isChildProcessTreeAliveAsync({ pid: childPid });
      const forceAndObserve = async () => {
        if (identityReady) {
          await identityReady;
        }
        if (!isDirectChildAlive() && !(await groupAlive())) {
          return;
        }
        const observed = readCommandProcessStartTime(childPid);
        const start = observed instanceof Promise ? await observed : observed;
        if (start !== null && start !== originalStart) {
          cleanup = "uncertain";
          if (isDirectChildAlive()) {
            params.cancelController.abort();
          }
          return;
        }
        if (!isDirectChildAlive() && isProcessGroupGoneByKernel(childPid)) {
          return;
        }
        cleanup = "forced";
        terminateProcessTree(childPid, { force: true, detached: true });
        scheduleAdoptedChildZombieReapAfterExit(params.child, true);
        // Signal delivery is not exit. Observe only this group; never re-signal a retired PID.
        cleanup =
          (await waitForCommandProcessGroupExit(childPid, async () => {
            const current = await readCommandProcessStartTime(childPid);
            return current === null || current === originalStart;
          })) === "exited"
            ? "forced"
            : "uncertain";
      };
      // Kernel absence remains an immediate result; denied probes are joined below.
      if (!directChildAlive && isProcessGroupGoneByKernel(childPid)) {
        return false;
      }
      processTreeSettlement = (async () => {
        if (force) {
          await forceAndObserve();
          return;
        }
        if (!isDirectChildAlive()) {
          if (identityReady) {
            await identityReady;
          }
          if (!(await groupAlive())) {
            return;
          }
          const start = await readCommandProcessStartTime(childPid);
          if (start !== null && start !== originalStart) {
            cleanup = "uncertain";
            return;
          }
          // Keep the final identity check adjacent to delivery after async observation.
          if (isProcessGroupGoneByKernel(childPid)) {
            return;
          }
        }
        cleanup = "cooperative";
        try {
          process.kill(-childPid, params.killSignal ?? "SIGTERM");
        } catch (error) {
          if (!hasErrnoCode(error, "ESRCH")) {
            cleanup = "uncertain";
          }
        }
        scheduleAdoptedChildZombieReapAfterExit(
          params.child,
          true,
          params.killGraceMs + COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS,
        );
        const deadline = performance.now() + params.killGraceMs;
        while (await groupAlive()) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) {
            await forceAndObserve();
            return;
          }
          await sleep(Math.min(25, remaining));
        }
        cleanup = "cooperative";
      })();
      return !force;
    }
    if (!directChildAlive) {
      return false;
    }
    if (process.platform === "win32" && typeof childPid === "number") {
      startWindowsTermination(childPid, false);
      return true;
    }
    return false;
  };

  const settle = async (): Promise<"normal" | "cooperative" | "forced" | "uncertain"> => {
    await identityReady;
    if (windowsTerminationPromise) {
      await windowsTerminationPromise;
      return "forced";
    }
    await processTreeSettlement;
    return cleanup;
  };

  const cancel = () => {
    const abortDeferred = terminate();
    if (!abortDeferred) {
      params.cancelController.abort();
    } else {
      // Async tree observation can confirm absence after cancellation deferred its abort.
      void settle().then(
        () => {
          if (!params.isCommandSettled()) {
            params.cancelController.abort();
          }
        },
        () => {}, // The caller retains the settlement failure.
      );
    }
  };

  if (preparation) {
    identityReady = preparation.then(
      async (prepared) => {
        const observed =
          typeof prepared === "number" || prepared === null ? prepared : readOriginalStart();
        originalStart = observed instanceof Promise ? await observed : observed;
        awaitingSpawn = false;
        if (terminateWhenSpawned) {
          // The runner owns cancellation; an ordinary early exit only requests tree settlement.
          terminate();
        }
      },
      () => {
        awaitingSpawn = false;
      },
    );
  }
  return { terminate, cancel, settle };
}
