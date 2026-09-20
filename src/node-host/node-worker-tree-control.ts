import { setTimeout as delay } from "node:timers/promises";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { signalProcessTree } from "../process/kill-tree.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

type NodeWorkerTreeState = "live" | "dead" | "unknown";

const RECOVERY_POLL_MS = 25;

function inspectPosixProcessGroup(pid: number): NodeWorkerTreeState {
  try {
    process.kill(-pid, 0);
    return "live";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

export function inspectOwnedNodeWorkerTree(worker: NodeWorkerProcessIdentity): NodeWorkerTreeState {
  const root = inspectNodeWorkerProcessIdentity(worker);
  if (root === "live" || root === "unknown") {
    return root;
  }
  if (process.platform === "win32") {
    // Windows descendants need their native Job certificate; root identity is insufficient.
    return "unknown";
  }
  return root === "reused" ? "dead" : inspectPosixProcessGroup(worker.pid);
}

export async function signalOwnedNodeWorkerTree(
  worker: NodeWorkerProcessIdentity,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  const root = inspectNodeWorkerProcessIdentity(worker);
  if (root === "reused" || root === "unknown") {
    return;
  }
  if (process.platform !== "win32") {
    if (inspectPosixProcessGroup(worker.pid) !== "live") {
      return;
    }
    // The detached worker PID is also its process-group id. Never fall back to
    // direct PID signaling after restart; a reused PID belongs to another tree.
    const revalidatedRoot = inspectNodeWorkerProcessIdentity(worker);
    if (revalidatedRoot === "reused" || revalidatedRoot === "unknown") {
      return;
    }
    try {
      process.kill(-worker.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
    return;
  }
  if (root !== "live" || inspectNodeWorkerProcessIdentity(worker) !== "live") {
    return;
  }
  await new Promise<void>((resolve) => {
    signalProcessTree(worker.pid, signal, { detached: true, onComplete: resolve });
  });
}

/** A recognized cleanup observer owns delivery to its child and must not receive group escalation. */
export function signalOwnedNodeWorkerAnchor(
  worker: NodeWorkerProcessIdentity,
  isOwnerCurrent: () => boolean,
): void {
  if (!isOwnerCurrent() || inspectNodeWorkerProcessIdentity(worker) !== "live") {
    return;
  }
  try {
    process.kill(worker.pid, "SIGTERM");
  } catch (error) {
    if (extractErrorCode(error) !== "ESRCH") {
      throw error;
    }
  }
}

export async function waitForOwnedNodeWorkerTreeDeath(
  worker: NodeWorkerProcessIdentity,
  timeoutMs?: number,
  isOwnerCurrent?: () => boolean,
): Promise<NodeWorkerTreeState> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  let state = inspectOwnedNodeWorkerTree(worker);
  while (state === "live" && Date.now() < deadline) {
    if (isOwnerCurrent?.() === false) {
      break;
    }
    await delay(RECOVERY_POLL_MS);
    state = inspectOwnedNodeWorkerTree(worker);
  }
  return state;
}

export async function stopOwnedNodeWorkerTree(
  worker: NodeWorkerProcessIdentity,
  graceMs: number,
  forceWaitMs: number,
): Promise<void> {
  let treeState = inspectOwnedNodeWorkerTree(worker);
  if (treeState === "live") {
    await signalOwnedNodeWorkerTree(worker, "SIGTERM");
    treeState = await waitForOwnedNodeWorkerTreeDeath(worker, graceMs);
  }
  if (treeState === "live") {
    await signalOwnedNodeWorkerTree(worker, "SIGKILL");
    await waitForOwnedNodeWorkerTreeDeath(worker, forceWaitMs);
  }
}
