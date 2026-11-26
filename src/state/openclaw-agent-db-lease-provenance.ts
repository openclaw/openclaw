import { createHash } from "node:crypto";
import fs from "node:fs";
import { hostname } from "node:os";
import {
  createManagedHandoffBootIdentityReader,
  predatesCurrentBoot,
} from "../infra/update-managed-service-handoff-boot.js";
import { getFileLockProcessStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { VERSION } from "../version.js";

let boot: string | null | undefined;

export function mayShareAgentDatabaseFile(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  try {
    const first = fs.statSync(left, { bigint: true, throwIfNoEntry: false });
    const second = fs.statSync(right, { bigint: true, throwIfNoEntry: false });
    return !first || !second || (first.dev === second.dev && first.ino === second.ino);
  } catch {
    // An inaccessible or replaced lease path cannot prove exclusive ownership.
    return true;
  }
}

type AgentDatabaseLeaseStaleReason =
  | "owner-pid-dead"
  | "owner-start-time-changed"
  | "owner-prior-boot";

/** Observe boot identity at most once per scan, never retain it across repairs. */
export function createAgentDatabaseLeaseStaleReasonReader() {
  let currentBoot:
    | ReturnType<ReturnType<typeof createManagedHandoffBootIdentityReader>>
    | null
    | undefined;
  return (row: {
    owner_pid: number;
    owner_start_time: number | null;
    opened_at: number;
  }): AgentDatabaseLeaseStaleReason | undefined => {
    if (isPidDefinitelyDead(row.owner_pid)) {
      return "owner-pid-dead";
    }
    if (row.owner_start_time === null) {
      if (row.opened_at <= 0) {
        return undefined;
      }
      if (currentBoot === undefined) {
        try {
          currentBoot = createManagedHandoffBootIdentityReader(process.env)();
        } catch {
          currentBoot = null;
        }
      }
      return predatesCurrentBoot(row.opened_at, currentBoot ?? undefined)
        ? "owner-prior-boot"
        : undefined;
    }
    const currentStartTime = getFileLockProcessStartTime(row.owner_pid);
    return currentStartTime !== null && row.owner_start_time !== currentStartTime
      ? "owner-start-time-changed"
      : undefined;
  };
}

export function readAgentDatabaseLeaseProvenance(pathname: string): string | null {
  try {
    if (boot === undefined) {
      // Boot identity lasts for this process; failed OS probes must not repeat on every open.
      boot = null;
      if (["linux", "darwin", "win32"].includes(process.platform)) {
        const currentBoot = createManagedHandoffBootIdentityReader(process.env)();
        // Linux PID death is only evidence inside the same procfs namespace.
        const namespace =
          currentBoot.platform === "linux"
            ? fs.readlinkSync("/proc/self/ns/pid")
            : currentBoot.platform;
        boot = [hostname(), currentBoot.identity, namespace, VERSION].join("\0");
      }
    }
    if (!boot) {
      return null;
    }
    const file = fs.statSync(pathname, { bigint: true });
    return file.isFile()
      ? `process-v1:${createHash("sha256").update(`${boot}\0${file.dev}:${file.ino}`).digest("hex")}`
      : null;
  } catch {
    return null;
  }
}
