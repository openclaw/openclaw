import { setTimeout as delay } from "node:timers/promises";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getProcessInstanceStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { killProcessTree } from "../kill-tree.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import { readProcessGroupMembers } from "../supervisor/service-child-group-ownership.js";
import { SpawnBrokerError } from "./protocol.js";

function groupGone(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return extractErrorCode(error) === "ESRCH";
  }
}

export type BrokerChildGroupIdentity = {
  pid: number;
  startedAt: number | null;
  /** The unreplaced native ChildProcess owns this fact until its exit callback. */
  isLeaderAlive?: () => boolean;
};

/** Once the original group is absent or its leader identity changes, never signal its number again. */
export function isBrokerChildGroupAlive(identity: BrokerChildGroupIdentity): boolean {
  if (groupGone(identity.pid)) {
    return false;
  }
  const current = getProcessInstanceStartTime(identity.pid);
  if (identity.isLeaderAlive) {
    if (identity.isLeaderAlive()) {
      // Native child custody is stronger than a best-effort platform birth probe.
      return identity.startedAt === null || current === null || current === identity.startedAt;
    }
    // After the native exit, a live positive PID can only be a replacement.
    if (!isPidDefinitelyDead(identity.pid)) {
      return false;
    }
    return identity.startedAt === null || current === null || current === identity.startedAt;
  }
  if (identity.startedAt === null || (current === null && !isPidDefinitelyDead(identity.pid))) {
    throw new SpawnBrokerError(
      `Spawn broker group leader identity is unavailable for pid=${identity.pid}`,
    );
  }
  return current === null || current === identity.startedAt;
}

function terminateRetainedBrokerChildGroup(identity: BrokerChildGroupIdentity) {
  let retired = false;
  let forced = false;
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    if (retired) {
      return;
    }
    if (!isBrokerChildGroupAlive(identity)) {
      retired = true;
      return;
    }
    try {
      process.kill(-identity.pid, value);
    } catch (error) {
      if (extractErrorCode(error) !== "ESRCH") {
        throw error;
      }
      retired = true;
    }
  };
  const force = () => {
    if (retired || forced) {
      return;
    }
    forced = true;
    signal("SIGKILL");
  };
  const settled = (async () => {
    const graceEndsAt = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
    const deadline = graceEndsAt + 2000;
    try {
      signal("SIGTERM");
      for (;;) {
        if (retired || !isBrokerChildGroupAlive(identity)) {
          break;
        }
        if (Date.now() >= graceEndsAt) {
          force();
        }
        if (Date.now() >= deadline) {
          throw new SpawnBrokerError(
            `Spawn broker child cleanup could not be confirmed for pid=${identity.pid}`,
          );
        }
        // This join, not an unreferenced escalation timer, owns the whole group.
        await delay(50);
      }
    } finally {
      retired = true;
    }
  })();
  return { force, settled };
}

/** Preserve a lost broker's tree cleanup across host restart and process exit. */
export function terminateLostBrokerChild(
  pid: number,
  detached: boolean,
  ownerExited?: Promise<void>,
  groupIdentity?: BrokerChildGroupIdentity,
) {
  if (detached && groupIdentity) {
    if (groupIdentity.pid !== pid) {
      throw new SpawnBrokerError("Spawn broker cleanup identity changed");
    }
    return terminateRetainedBrokerChildGroup(groupIdentity);
  }
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

/** Drain abandoned members without killing the broker while its isolate is closing. */
export async function drainCurrentBrokerProcessGroup(): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const deadline = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
  const signaled = new Map<string, NodeJS.Signals>();
  for (;;) {
    const members = [...readProcessGroupMembers(1000)];
    if (!members.some((member) => member.pid === process.pid && member.pgid === process.pid)) {
      throw new SpawnBrokerError("Spawn broker lost its private process group");
    }
    const pending = members.filter(
      (member) =>
        member.pid !== process.pid &&
        member.pgid === process.pid &&
        !isPidDefinitelyDead(member.pid),
    );
    if (!pending.length) {
      return;
    }
    const signal = Date.now() < deadline ? "SIGTERM" : "SIGKILL";
    const identities = new Map(
      pending.map((member) => [member.pid, getProcessInstanceStartTime(member.pid)]),
    );
    // Membership and birth are revalidated together immediately before each signal.
    for (const member of readProcessGroupMembers(1000)) {
      if (
        member.pid === process.pid ||
        member.pgid !== process.pid ||
        !identities.has(member.pid)
      ) {
        continue;
      }
      const identity = identities.get(member.pid);
      if (identity === null) {
        if (!isPidDefinitelyDead(member.pid)) {
          throw new SpawnBrokerError(
            `Spawn broker cannot identify remaining group member pid=${member.pid}`,
          );
        }
        continue;
      }
      if (getProcessInstanceStartTime(member.pid) !== identity) {
        continue;
      }
      const key = `${member.pid}:${identity}`;
      if (signaled.get(key) === signal) {
        continue;
      }
      try {
        process.kill(member.pid, signal);
      } catch (error) {
        if (extractErrorCode(error) !== "ESRCH") {
          throw error;
        }
      }
      signaled.set(key, signal);
    }
    await delay(50);
  }
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
