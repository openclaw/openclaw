import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import {
  listProcesses,
  readProcessCommand,
  type ProcessSnapshot,
} from "@openclaw/proc-safe/inspect";

export type DarwinProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  owner: ProcessSnapshot["owner"];
  startedAt: string;
};
type DarwinCensusProcess = Omit<DarwinProcess, "startedAt">;
type DarwinSnapshot = ProcessSnapshot &
  Required<Pick<ProcessSnapshot, "parentPid" | "processGroupId" | "state">>;

export class DarwinProcessInspectionError extends Error {
  readonly code: "ETIMEDOUT" | "EPERM" | "EIO";

  constructor(
    readonly reason: "deadline" | "permission" | "unavailable",
    options?: ErrorOptions,
  ) {
    super(`Darwin process inspection ${reason}`, options);
    this.name = "DarwinProcessInspectionError";
    this.code = reason === "deadline" ? "ETIMEDOUT" : reason === "permission" ? "EPERM" : "EIO";
  }
}

function failure(cause: unknown): DarwinProcessInspectionError {
  if (cause instanceof DarwinProcessInspectionError) {
    return cause;
  }
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  return new DarwinProcessInspectionError(
    code === "ETIMEDOUT" || code === "ABORT_ERR" || code === "timeout"
      ? "deadline"
      : ["EACCES", "EPERM", "ERR_ACCESS_DENIED", "access-denied"].includes(String(code))
        ? "permission"
        : "unavailable",
    { cause },
  );
}

function remaining(deadline: number): number {
  const ms = Math.floor(deadline - performance.now());
  if (ms <= 0) {
    throw new DarwinProcessInspectionError("deadline");
  }
  return ms;
}

const states = {
  running: "R",
  sleeping: "S",
  stopped: "T",
  zombie: "Z",
  idle: "I",
  unknown: "?",
} as const;

function hasReadableTopology(row: ProcessSnapshot): row is DarwinSnapshot {
  if (row.parentPid === undefined || row.processGroupId === undefined || row.state === undefined) {
    // A PID can disappear during enumeration. Only current kernel absence lets
    // us omit an incomplete row; inaccessible live topology still fails closed.
    if (readProcessIdentity(row.pid) === null) {
      return false;
    }
    throw new DarwinProcessInspectionError("unavailable");
  }
  return true;
}

function topology(row: DarwinSnapshot): DarwinCensusProcess {
  return {
    pid: row.pid,
    ppid: row.parentPid,
    pgid: row.processGroupId,
    state: states[row.state],
    owner: row.owner,
  };
}

function startIdentity(identity: ProcessSnapshot["identity"]): string {
  if (!identity) {
    throw new DarwinProcessInspectionError("permission");
  }
  const date = new Date(Math.floor(identity.startTimeMicros / 1_000_000) * 1000);
  if (!Number.isFinite(date.getTime()) || identity.startTimeMicros <= 0) {
    throw new DarwinProcessInspectionError("unavailable");
  }
  // Match normalized LC_ALL=C TZ=UTC ps lstart: Codex persists these identities
  // across upgrades and Node/Bun switches. Fingerprints guard second-level reuse.
  const [day, dayOfMonth, month, year, time] = date.toUTCString().split(" ");
  return `${day!.slice(0, -1)} ${month} ${Number(dayOfMonth)} ${time} ${year}`;
}

function census(deadline: number, pids?: readonly number[]): DarwinSnapshot[] {
  try {
    const rows = listProcesses({
      timeoutMs: remaining(deadline),
      ...(pids ? { pids } : {}),
    }).filter(hasReadableTopology);
    remaining(deadline);
    return rows;
  } catch (cause) {
    remaining(deadline);
    throw failure(cause);
  }
}

/** Complete census, or selected identities. Missing PIDs are omitted; inspection errors throw. */
export async function readDarwinProcessSnapshot(
  deadline: number,
  pids?: readonly number[],
): Promise<DarwinProcess[]> {
  if (pids?.some((pid) => !Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff)) {
    throw new DarwinProcessInspectionError("unavailable");
  }
  if (pids?.length === 0) {
    return [];
  }
  const rows = census(deadline, pids).map((row) =>
    Object.assign(topology(row), { startedAt: startIdentity(row.identity) }),
  );
  remaining(deadline);
  return rows;
}

/** Inspect a complete lineage without requiring start-time access to unrelated users. */
export async function readDarwinProcessTree(
  deadline: number,
  roots: readonly number[],
): Promise<DarwinProcess[]> {
  const tree = census(deadline).map((row) => ({
    process: topology(row),
    identity: row.identity,
  }));
  const selected = new Set([process.pid, ...roots]);
  const pending = [...roots];
  for (const parent of pending) {
    for (const { process: row } of tree) {
      if (row.ppid === parent && !selected.has(row.pid)) {
        selected.add(row.pid);
        pending.push(row.pid);
      }
    }
  }
  // Unrelated users may deny birth identities. Only the selected lineage needs
  // them; missing relevant identity must never be treated as disappearance.
  const result = tree
    .filter(({ process: row }) => selected.has(row.pid))
    .map(({ process: row, identity }) =>
      Object.assign(row, { startedAt: startIdentity(identity) }),
    );
  remaining(deadline);
  return result;
}

/** Synchronous census for the process-group cleanup worker, without spawning ps. */
export function* readDarwinProcessCensus(timeoutMs: number): Generator<DarwinCensusProcess> {
  const deadline = performance.now() + timeoutMs;
  const rows = census(deadline).map(topology);
  for (const row of rows) {
    remaining(deadline);
    yield row;
  }
  remaining(deadline);
}

/** Arguments only: never request or return process environment values. */
export async function readDarwinProcessCommandLine(pid: number, deadline: number): Promise<string> {
  remaining(deadline);
  try {
    const command = readProcessCommand(pid);
    remaining(deadline);
    return command?.argv.join(" ") ?? "";
  } catch (cause) {
    remaining(deadline);
    throw failure(cause);
  }
}
