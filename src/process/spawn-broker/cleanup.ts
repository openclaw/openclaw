import { setTimeout as delay } from "node:timers/promises";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { killProcessTree } from "../kill-tree.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { SpawnBrokerError } from "./protocol.js";

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return extractErrorCode(error) === "ESRCH";
  }
}

/** Preserve a lost broker's tree cleanup across host restart and process exit. */
export function terminateLostBrokerChild(
  pid: number,
  detached: boolean,
  ownerExited?: Promise<void>,
) {
  const termination = killProcessTree(pid, { detached, graceMs: GRACEFUL_CANCEL_TIMEOUT_MS });
  const graceEndsAt = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
  const settled = (async () => {
    let deadline = graceEndsAt + 2000;
    if (ownerExited) {
      // A stopped broker retains killed children as zombies until its own exit.
      // Keep signaling on schedule, but budget observation after reaping can proceed.
      await ownerExited;
      deadline = Math.max(deadline, Date.now() + 2000);
    }
    // The attached-tree owner's captured descendants retain their entire TERM/KILL grace.
    if (!detached && Date.now() < graceEndsAt) {
      await delay(graceEndsAt - Date.now());
    }
    for (;;) {
      if (isPidDefinitelyDead(pid) && (!detached || groupGone(pid))) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new SpawnBrokerError(
          `Spawn broker child cleanup could not be confirmed for pid=${pid}`,
        );
      }
      await delay(50);
    }
  })();
  return { force: () => termination?.force(), settled };
}

/** A broker's private group retains non-detached children before PID publication. */
export function terminateBrokerProcessGroup(pgid: number) {
  let retired = false;
  let signalError: unknown;
  let forceTimer: NodeJS.Timeout | undefined;
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-pgid, value);
    } catch (error) {
      if (extractErrorCode(error) !== "ESRCH") {
        signalError = error;
      }
    }
  };
  const retire = () => {
    retired = true;
    clearTimeout(forceTimer);
  };
  const force = () => {
    if (retired) {
      return;
    }
    if (groupGone(pgid)) {
      retire();
      return;
    }
    clearTimeout(forceTimer);
    signal("SIGKILL");
  };
  const settled = (async () => {
    if (groupGone(pgid)) {
      retire();
      return;
    }
    signal("SIGTERM");
    forceTimer = setTimeout(force, GRACEFUL_CANCEL_TIMEOUT_MS);
    const deadline = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS + 2000;
    try {
      while (!groupGone(pgid)) {
        if (Date.now() >= deadline) {
          throw new SpawnBrokerError(
            `Spawn broker group cleanup could not be confirmed for pgid=${pgid}`,
            { cause: signalError },
          );
        }
        await delay(50);
      }
    } finally {
      // A disappeared process group no longer authorizes delayed numeric-PGID signals.
      retire();
    }
  })();
  return { force, settled };
}
