import path from "node:path";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectProcessAncestorPids,
  getFileLockProcessStartTime,
  isPidDefinitelyDead,
  readDarwinProcessIdentity,
} from "../shared/pid-alive.js";
import type { HandoffProcessIdentity } from "./update-managed-service-handoff-schema.js";
import { readWindowsProcessArgsSync } from "./windows-port-pids.js";

const WINDOWS_ARGV_IDENTITY_PREFIX = "win32-argv-sha256:";
const WINDOWS_ARGV_IDENTITY_PATTERN = /^win32-argv-sha256:[a-f0-9]{64}$/;

function windowsArgvIdentity(argv: readonly string[]): string | null {
  if (!argv[0]) {
    return null;
  }
  const normalized = [path.win32.normalize(argv[0]).toLowerCase(), ...argv.slice(1)];
  return WINDOWS_ARGV_IDENTITY_PREFIX + sha256Hex(JSON.stringify(normalized));
}

/** Process facts shared by lease admission, live ownership, and cleanup. */
export function createManagedHandoffProcessIdentityReader(options: {
  env: NodeJS.ProcessEnv;
  onWarning?: (pid: number, message: string) => void;
}) {
  const warnedIdentityPids = new Set<number>();
  let selfIdentity: HandoffProcessIdentity | undefined;
  let parentStartIdentity: string | undefined;
  let selfLauncherIdentity: string | null | undefined;
  function warn(pid: number, continuation: string) {
    if (warnedIdentityPids.has(pid)) {
      return;
    }
    warnedIdentityPids.add(pid);
    try {
      options.onWarning?.(
        pid,
        `Native Windows creation-time queries returned no identity for PID ${pid}; ${continuation}.`,
      );
    } catch {
      // Diagnostic persistence cannot interrupt an attributed update process.
    }
  }
  // Lease reclamation needs ESRCH evidence; other probe errors cannot prove absence.
  const isPidAlive = (pid: number) => !isPidDefinitelyDead(pid);

  function readProcessStartIdentity(pid: number): string | null {
    const start = getFileLockProcessStartTime(pid, {
      ...options.env,
      LC_ALL: "C",
      TZ: "UTC",
    });
    return start === null
      ? pid === process.pid
        ? (parentStartIdentity ?? null)
        : null
      : String(start);
  }

  function validateDarwinAncestorProcesses(
    requiredHelperPid: number,
    validate: (
      ancestors: ReadonlySet<number>,
      isProcessIdentityCurrent: (identity: HandoffProcessIdentity) => boolean,
    ) => boolean,
  ): boolean {
    const immediateParent = process.ppid;
    // These facts belong to this synchronous validation only, never to the reader's lifetime.
    const observed = new Map<number, ReturnType<typeof readDarwinProcessIdentity>>();
    const read = (pid: number) => {
      if (!observed.has(pid)) {
        observed.set(pid, readDarwinProcessIdentity(pid, options.env));
      }
      return observed.get(pid) ?? null;
    };
    const ancestors = collectProcessAncestorPids(
      immediateParent,
      (pid) => read(pid)?.parentPid ?? null,
      requiredHelperPid,
    );
    if (
      !ancestors.has(requiredHelperPid) ||
      !read(requiredHelperPid) ||
      process.ppid !== immediateParent
    ) {
      return false;
    }
    return validate(ancestors, (value) => {
      const facts = observed.get(value.pid);
      return (
        isPidAlive(value.pid) && facts != null && String(facts.startedAt) === value.startIdentity
      );
    });
  }

  function readWindowsArgvIdentity(pid: number): string | null {
    if (pid !== process.pid) {
      const argv = readWindowsProcessArgsSync(pid, undefined, options.env);
      return argv ? windowsArgvIdentity(argv) : null;
    }
    if (selfLauncherIdentity === undefined) {
      // Node retains startup argv even after the CLI removes root profile options.
      const report = process.report.getReport();
      const argv = isRecord(report) && isRecord(report.header) ? report.header.commandLine : null;
      selfLauncherIdentity =
        Array.isArray(argv) && argv.every((arg: unknown): arg is string => typeof arg === "string")
          ? windowsArgvIdentity(argv)
          : null;
    }
    return selfLauncherIdentity;
  }
  function inspectProcessIdentity(
    value: HandoffProcessIdentity,
    ownedCustody = false,
  ): "live" | "dead" | "unknown" | "mismatch" {
    if (!isPidAlive(value.pid)) {
      return "dead";
    }
    if (process.platform === "win32" && WINDOWS_ARGV_IDENTITY_PATTERN.test(value.startIdentity)) {
      const argvIdentity = readWindowsArgvIdentity(value.pid);
      return argvIdentity === null
        ? ownedCustody
          ? "live"
          : "unknown"
        : argvIdentity === value.startIdentity
          ? "live"
          : "mismatch";
    }
    const start = readProcessStartIdentity(value.pid);
    return start === null ? "unknown" : start === value.startIdentity ? "live" : "mismatch";
  }
  function processState(value: HandoffProcessIdentity): "live" | "dead" | "unknown" {
    const state = inspectProcessIdentity(value);
    // Launcher disagreement revokes attribution; it cannot prove process death.
    if (state === "mismatch") {
      return process.platform === "win32" && WINDOWS_ARGV_IDENTITY_PATTERN.test(value.startIdentity)
        ? "unknown"
        : "dead";
    }
    return state;
  }
  function isProcessIdentityCurrent(value: HandoffProcessIdentity, ownedCustody = false): boolean {
    return inspectProcessIdentity(value, ownedCustody) === "live";
  }
  function acceptSelfIdentity(value: HandoffProcessIdentity, parentBound = false): boolean {
    if (value.pid !== process.pid) {
      return false;
    }
    const state = inspectProcessIdentity(value);
    if (state === "live") {
      selfIdentity ??= { ...value };
      return true;
    }
    if (
      state !== "unknown" ||
      !parentBound ||
      process.platform !== "win32" ||
      WINDOWS_ARGV_IDENTITY_PATTERN.test(value.startIdentity)
    ) {
      return false;
    }
    // The caller verified the live parent and its current receiver admission.
    // A process cannot outlive its own start identity; foreign probes stay fresh.
    parentStartIdentity = value.startIdentity;
    selfIdentity ??= { ...value };
    warn(value.pid, "continuing with the creation identity established by the live parent");
    return true;
  }
  function processIdentity(pid = process.pid, argv?: readonly string[]): HandoffProcessIdentity {
    if (pid === process.pid && selfIdentity) {
      // This executing process is live; only observed identity disagreement can revoke its pin.
      const observed =
        process.platform === "win32" &&
        WINDOWS_ARGV_IDENTITY_PATTERN.test(selfIdentity.startIdentity)
          ? readWindowsArgvIdentity(pid)
          : readProcessStartIdentity(pid);
      if (observed !== null && observed !== selfIdentity.startIdentity) {
        throw new Error("managed handoff process identity changed");
      }
      return { ...selfIdentity };
    }
    const startIdentity = readProcessStartIdentity(pid);
    if (startIdentity !== null) {
      if (pid === process.pid) {
        selfIdentity = { pid, startIdentity };
      }
      return { pid, startIdentity };
    }
    const attribution =
      process.platform === "win32"
        ? argv
          ? windowsArgvIdentity(argv)
          : readWindowsArgvIdentity(pid)
        : null;
    if (attribution) {
      warn(pid, "continuing with PID and launcher attribution");
      if (pid === process.pid) {
        selfIdentity = { pid, startIdentity: attribution, startIdentitySource: "argv-sha256" };
      }
      return { pid, startIdentity: attribution, startIdentitySource: "argv-sha256" };
    }
    throw new Error("managed handoff process start identity is unavailable");
  }
  return {
    isPidAlive,
    readProcessStartIdentity,
    processIdentity,
    processState,
    inspectProcessIdentity,
    isProcessIdentityCurrent,
    validateDarwinAncestorProcesses,
    acceptSelfIdentity,
  };
}
