import { closeSync, openSync } from "node:fs";
import { readFileDescriptorBoundedSync } from "../infra/boundary-file-read.js";
import { spawnPsSync } from "../infra/spawn-ps.js";
import { OWNED_NODE_WORKER_ANCHOR_ARG } from "../process/supervisor/service-child-protocol.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";

export type NodeWorkerProcessIdentity = {
  pid: number;
  startTime: number;
};

type NodeWorkerProcessIdentityState = "live" | "dead" | "reused" | "unknown";
type NodeWorkerProcessRole = "owned-anchor" | "legacy" | "unknown";

const PROCESS_ROLE_PROBE_TIMEOUT_MS = 1_000;
const MAX_PROCESS_ARGV_BYTES = 64 * 1024;

export function requireNodeWorkerProcessIdentity(pid: number): NodeWorkerProcessIdentity {
  const startTime = getFileLockProcessStartTime(pid);
  if (startTime === null) {
    throw new Error(`cannot establish PID-reuse-safe identity for process ${pid}`);
  }
  return { pid, startTime };
}

export function inspectNodeWorkerProcessIdentity(
  identity: NodeWorkerProcessIdentity,
): NodeWorkerProcessIdentityState {
  const observedStartTime = getFileLockProcessStartTime(identity.pid);
  if (observedStartTime !== null) {
    if (observedStartTime !== identity.startTime) {
      return "reused";
    }
    return isPidDefinitelyDead(identity.pid) ? "dead" : "live";
  }
  return isPidDefinitelyDead(identity.pid) ? "dead" : "unknown";
}

/** Classifies an already-owned process; argv never establishes PID ownership. */
export function inspectNodeWorkerProcessRole(
  identity: NodeWorkerProcessIdentity,
): NodeWorkerProcessRole {
  if (inspectNodeWorkerProcessIdentity(identity) !== "live") {
    return "unknown";
  }
  let args: string[];
  try {
    if (process.platform === "linux") {
      const fd = openSync(`/proc/${identity.pid}/cmdline`, "r");
      try {
        args = readFileDescriptorBoundedSync(fd, MAX_PROCESS_ARGV_BYTES)
          .toString("utf8")
          .split("\0")
          .filter((arg) => arg.length > 0);
      } finally {
        closeSync(fd);
      }
    } else if (process.platform === "darwin") {
      const probe = spawnPsSync(
        ["-ww", "-p", String(identity.pid), "-o", "command="],
        PROCESS_ROLE_PROBE_TIMEOUT_MS,
      );
      if (
        probe.error ||
        probe.status !== 0 ||
        Buffer.byteLength(probe.stdout) > MAX_PROCESS_ARGV_BYTES
      ) {
        return "unknown";
      }
      args = probe.stdout.trim().split(/\s+/u);
    } else {
      return "unknown";
    }
  } catch {
    return "unknown";
  }
  if (!args[0] || inspectNodeWorkerProcessIdentity(identity) !== "live") {
    return "unknown";
  }
  return args.at(-1) === OWNED_NODE_WORKER_ANCHOR_ARG ? "owned-anchor" : "legacy";
}
