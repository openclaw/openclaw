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
      // procfs supplies both a boot identity and the namespace in which PID death is observed.
      const bootId =
        process.platform === "linux"
          ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
          : "";
      boot = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)
        ? [hostname(), bootId, fs.readlinkSync("/proc/self/ns/pid"), VERSION].join("\0")
        : null;
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

function isSameBootAgentDatabaseLease(provenance: string | null, pathname: string): boolean {
  return provenance !== null && provenance === readAgentDatabaseLeaseProvenance(pathname);
}

export function agentDatabaseLeaseProcessDeathRefusal(
  row: {
    opened_at: number;
    owner_start_time: number | null;
    path: string;
    provenance: string | null;
  },
  pathname: string,
  staleReason: AgentDatabaseLeaseStaleReason,
): string | undefined {
  if (staleReason !== "owner-pid-dead") {
    return staleReason;
  }
  if (row.opened_at < 0) {
    return "predecessor-full-required";
  }
  if (row.owner_start_time === null) {
    return "owner-start-time-missing";
  }
  if (row.path !== pathname) {
    return "lease-path-mismatch";
  }
  if (row.provenance === null) {
    return "legacy-provenance-missing";
  }
  return isSameBootAgentDatabaseLease(row.provenance, pathname)
    ? undefined
    : "host-boot-namespace-version-file-mismatch";
}

export function agentDatabaseAdmissionProvenanceRefusal(
  provenance: string | null | undefined,
  pathname: string,
): string | undefined {
  return provenance === undefined
    ? "native-admission-required"
    : isSameBootAgentDatabaseLease(provenance, pathname)
      ? undefined
      : "prepared-provenance-mismatch";
}
