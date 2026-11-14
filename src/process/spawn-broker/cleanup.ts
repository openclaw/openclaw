import { setTimeout as delay } from "node:timers/promises";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getProcessInstanceStartTime, isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { isDeniedProcessGroupProbe, isProcessGroupGone } from "../child-process-tree.js";
import { killProcessTree } from "../kill-tree.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "../supervisor/cancellation-policy.js";
import {
  isOwnProcfs,
  readProcessGroupMembers,
} from "../supervisor/service-child-group-ownership.js";
import { SpawnBrokerError } from "./protocol.js";

export type BrokerChildGroupIdentity = {
  pid: number;
  startedAt: number | null;
  /** The unreplaced native ChildProcess owns this fact until its exit callback. */
  isLeaderAlive?: () => boolean;
};

/** Once the original group is absent or its leader identity changes, never signal its number again. */
export function isBrokerChildGroupAlive(identity: BrokerChildGroupIdentity): boolean {
  if (isProcessGroupGone(identity.pid)) {
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

/**
 * Signals group members by positive PID, for hosts that deny negative-PID kill(2). The caller
 * reads the snapshot and owns `signaled`, which skips members already hit by this signal.
 * Returns how many members of the group were still pending in the snapshot.
 */
function signalRevalidatedGroupMembers(
  pgid: number,
  signal: NodeJS.Signals,
  {
    snapshot,
    signaled,
  }: { snapshot: readonly { pid: number; pgid: number }[]; signaled: Map<string, NodeJS.Signals> },
): number {
  // Positive PIDs of a foreign procfs name unrelated processes: never signal from one.
  if (!isOwnProcfs()) {
    throw new SpawnBrokerError(
      "Spawn broker cannot verify the process table belongs to its PID namespace",
    );
  }
  const pending = snapshot.filter(
    (member) =>
      member.pid !== process.pid && member.pgid === pgid && !isPidDefinitelyDead(member.pid),
  );
  if (!pending.length) {
    return 0;
  }
  const identities = new Map(
    pending.map((member) => [member.pid, getProcessInstanceStartTime(member.pid)]),
  );
  let failure: { error: unknown } | undefined;
  // Membership and birth are revalidated together immediately before each signal.
  for (const member of readProcessGroupMembers(1000)) {
    if (member.pid === process.pid || member.pgid !== pgid || !identities.has(member.pid)) {
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
        // A kernel group kill reaches every member it may signal: keep going, retry next tick.
        failure ??= { error };
        continue;
      }
    }
    signaled.set(key, signal);
  }
  if (failure) {
    throw failure.error;
  }
  return pending.length;
}

function terminateRetainedBrokerChildGroup(identity: BrokerChildGroupIdentity) {
  let retired = false;
  let forced = false;
  let signalError: unknown;
  // Once the host denies a group signal, members are signaled one by one on every tick.
  let denied: unknown;
  let phase: "SIGTERM" | "SIGKILL" = "SIGTERM";
  const signaled = new Map<string, NodeJS.Signals>();
  const signalMembers = () => {
    try {
      signalRevalidatedGroupMembers(identity.pid, phase, {
        snapshot: [...readProcessGroupMembers(1000)],
        signaled,
      });
    } catch (error) {
      signalError = error;
    }
  };
  const signal = (value: "SIGTERM" | "SIGKILL") => {
    if (retired) {
      return;
    }
    if (!isBrokerChildGroupAlive(identity)) {
      retired = true;
      return;
    }
    phase = value;
    try {
      process.kill(-identity.pid, value);
    } catch (error) {
      if (isDeniedProcessGroupProbe(error, value)) {
        denied = error;
        signalMembers();
      } else if (extractErrorCode(error) === "ESRCH") {
        retired = true;
      } else {
        throw error;
      }
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
    const graceEndsAt = performance.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
    const deadline = graceEndsAt + 2000;
    try {
      signal("SIGTERM");
      for (;;) {
        if (retired || !isBrokerChildGroupAlive(identity)) {
          break;
        }
        if (performance.now() >= graceEndsAt) {
          force();
        }
        if (denied && !retired) {
          // Members can join the group after any census, so the current phase repeats.
          signalMembers();
        }
        if (performance.now() >= deadline) {
          throw new SpawnBrokerError(
            `Spawn broker child cleanup could not be confirmed for pid=${identity.pid}`,
            { cause: signalError ?? denied },
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
  groupIdentity?: BrokerChildGroupIdentity,
) {
  if (detached && groupIdentity) {
    if (groupIdentity.pid !== pid) {
      throw new SpawnBrokerError("Spawn broker cleanup identity changed");
    }
    return terminateRetainedBrokerChildGroup(groupIdentity);
  }
  const termination = killProcessTree(pid, { detached, graceMs: GRACEFUL_CANCEL_TIMEOUT_MS });
  const deadline = performance.now() + GRACEFUL_CANCEL_TIMEOUT_MS + 2000;
  const settled = (async () => {
    // An attached root can exit before its descendants; the tree owner's exited()
    // keeps settlement joined to their TERM/KILL escalation. A detached tree is one
    // group, so the group owner decides; exited() still runs each tick so hosts with working
    // group probes clear agent-core's force timer. Under a denied host that timer stays armed,
    // is unref'd, and only signals the group (-pid), never a positive PID, so it is harmless.
    for (;;) {
      if (detached) {
        termination?.exited();
        if (isPidDefinitelyDead(pid) && isProcessGroupGone(pid)) {
          break;
        }
      } else if (isPidDefinitelyDead(pid) && (termination?.exited() ?? true)) {
        break;
      }
      if (performance.now() >= deadline) {
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
  const deadline = performance.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
  const signaled = new Map<string, NodeJS.Signals>();
  for (;;) {
    const members = [...readProcessGroupMembers(1000)];
    if (!members.some((member) => member.pid === process.pid && member.pgid === process.pid)) {
      throw new SpawnBrokerError("Spawn broker lost its private process group");
    }
    const signal = performance.now() < deadline ? "SIGTERM" : "SIGKILL";
    if (!signalRevalidatedGroupMembers(process.pid, signal, { snapshot: members, signaled })) {
      return;
    }
    await delay(50);
  }
}

/** A broker's private group retains non-detached children before PID publication. */
export function terminateBrokerProcessGroup(pgid: number) {
  let retired = false;
  let signalError: unknown;
  // Once the host denies a group signal, members are signaled one by one on every tick.
  let denied: unknown;
  let phase: NodeJS.Signals = "SIGTERM";
  const signaled = new Map<string, NodeJS.Signals>();
  let forceTimer: NodeJS.Timeout | undefined;
  const signalMembers = () => {
    try {
      signalRevalidatedGroupMembers(pgid, phase, {
        snapshot: [...readProcessGroupMembers(1000)],
        signaled,
      });
    } catch (error) {
      signalError = error;
    }
  };
  const signal = (value: NodeJS.Signals) => {
    phase = value;
    try {
      process.kill(-pgid, value);
    } catch (error) {
      if (isDeniedProcessGroupProbe(error, value)) {
        denied = error;
        signalMembers();
      } else if (extractErrorCode(error) !== "ESRCH") {
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
    if (isProcessGroupGone(pgid)) {
      retire();
      return;
    }
    clearTimeout(forceTimer);
    signal("SIGKILL");
  };
  const settled = (async () => {
    if (isProcessGroupGone(pgid)) {
      retire();
      return;
    }
    signal("SIGTERM");
    forceTimer = setTimeout(force, GRACEFUL_CANCEL_TIMEOUT_MS);
    const deadline = performance.now() + GRACEFUL_CANCEL_TIMEOUT_MS + 2000;
    try {
      while (!isProcessGroupGone(pgid)) {
        if (performance.now() >= deadline) {
          throw new SpawnBrokerError(
            `Spawn broker group cleanup could not be confirmed for pgid=${pgid}`,
            { cause: signalError ?? denied },
          );
        }
        if (denied) {
          signalMembers();
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
