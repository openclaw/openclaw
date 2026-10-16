import { execFile, spawnSync } from "node:child_process";
import {
  readDarwinBunProcessCensus,
  type DarwinProcess as DarwinCensusProcess,
} from "./supervisor/darwin-bun-process-census.js";

export type DarwinProcess = DarwinCensusProcess & { startedAt: string };

export class DarwinProcessInspectionError extends Error {
  constructor(
    readonly reason: "deadline" | "permission" | "unavailable",
    options?: ErrorOptions,
  ) {
    super(`Darwin process inspection ${reason}`, options);
    this.name = "DarwinProcessInspectionError";
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

const columns = "pid=,ppid=,pgid=,stat=,uid=,lstart=";
const maxBuffer = 8 * 1024 * 1024;
function argsFor(pids?: readonly number[]): string[] {
  return pids ? ["-o", columns, "-p", pids.join(",")] : ["-axo", columns];
}

function parse(output: string): DarwinProcess[] {
  return output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) {
        throw new DarwinProcessInspectionError("unavailable");
      }
      if (!match.slice(1, 4).every((value) => Number.isSafeInteger(Number(value)))) {
        throw new DarwinProcessInspectionError("unavailable");
      }
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        state: match[4]!,
        uid: Number(match[5]) >>> 0,
        startedAt: match[6]!.replace(/\s+/g, " "),
      };
    });
}

function nativeCensus(deadline: number, pids?: readonly number[]): DarwinProcess[] {
  try {
    const rows = [...readDarwinBunProcessCensus(remaining(deadline), pids, true)].map((row) => {
      if (!row.startedAt) {
        throw new DarwinProcessInspectionError("unavailable");
      }
      return {
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        state: row.state,
        uid: row.uid,
        startedAt: row.startedAt,
      };
    });
    remaining(deadline);
    return rows;
  } catch (cause) {
    remaining(deadline);
    throw failure(cause);
  }
}

/** Node has no FFI, and proc-safe has no Darwin census API. Keep its bounded ps path. */
async function ps(args: string[], deadline: number): Promise<string> {
  const ms = remaining(deadline);
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (cause: unknown, output = "") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (performance.now() >= deadline) {
        reject(new DarwinProcessInspectionError("deadline"));
      } else if (cause) {
        reject(failure(cause));
      } else {
        resolve(output);
      }
    };
    const child = execFile(
      "ps",
      args,
      { encoding: "utf8", maxBuffer, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      settle,
    );
    const timer = setTimeout(() => {
      settle(new DarwinProcessInspectionError("deadline"));
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGKILL");
      child.unref();
    }, ms);
    timer.unref?.();
  }).catch((cause: unknown) => {
    throw failure(cause);
  });
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
  if (process.versions.bun) {
    return nativeCensus(deadline, pids);
  }
  // ps exits 1 when no requested PIDs remain. A readable observer distinguishes
  // that ordinary absence from failed inspection without accepting exit errors.
  const selected = pids ? [...new Set([process.pid, ...pids])] : undefined;
  const rows = parse(await ps(argsFor(selected), deadline));
  if (selected && !rows.some((row) => row.pid === process.pid)) {
    throw new DarwinProcessInspectionError("unavailable");
  }
  return pids ? rows.filter((row) => pids.includes(row.pid)) : rows;
}

/** Inspect a complete lineage without requiring start-time access to unrelated users. */
export async function readDarwinProcessTree(
  deadline: number,
  roots: readonly number[],
): Promise<DarwinProcess[]> {
  const census = process.versions.bun
    ? [...readDarwinProcessCensus(remaining(deadline))]
    : await readDarwinProcessSnapshot(deadline);
  const selected = new Set([process.pid, ...roots]);
  const pending = [...roots];
  for (const parent of pending) {
    for (const row of census) {
      if (row.ppid === parent && !selected.has(row.pid)) {
        selected.add(row.pid);
        pending.push(row.pid);
      }
    }
  }
  // The short census supplies topology only. Every relevant process still needs
  // readable start identity; permission denial cannot prove it disappeared.
  return process.versions.bun
    ? readDarwinProcessSnapshot(deadline, [...selected])
    : census.filter((row): row is DarwinProcess => selected.has(row.pid) && Boolean(row.startedAt));
}

/** Synchronous census for the dependency-free process-group cleanup worker. */
export function* readDarwinProcessCensus(timeoutMs: number): Generator<DarwinCensusProcess> {
  const deadline = performance.now() + timeoutMs;
  if (process.versions.bun) {
    try {
      yield* readDarwinBunProcessCensus(remaining(deadline));
    } catch (cause) {
      remaining(deadline);
      throw failure(cause);
    }
    return;
  }
  // Group cleanup needs topology only; preserve Node's existing ps projection.
  const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat=,ppid=,uid="], {
    encoding: "utf8",
    timeout: remaining(deadline),
    maxBuffer,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  remaining(deadline);
  if (result.error || result.status !== 0) {
    throw failure(result.error);
  }
  for (const line of result.stdout.split("\n")) {
    remaining(deadline);
    if (!line.trim()) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(-?\d+)\s*$/.exec(line);
    if (
      !match ||
      ![match[1], match[2], match[4]].every((value) => Number.isSafeInteger(Number(value)))
    ) {
      throw new DarwinProcessInspectionError("unavailable");
    }
    const pid = Number(match[1]);
    if (pid !== result.pid) {
      yield {
        pid,
        pgid: Number(match[2]),
        state: match[3]!,
        ppid: Number(match[4]),
        uid: Number(match[5]) >>> 0,
      };
    }
  }
  remaining(deadline);
}

/** Arguments only: never request or return process environment values. */
export async function readDarwinProcessCommandLine(pid: number, deadline: number): Promise<string> {
  remaining(deadline);
  if (!process.versions.bun) {
    return (await ps(["-o", "command=", "-p", String(pid)], deadline)).split("\n")[0]?.trim() ?? "";
  }
  try {
    const { readProcessCommand } = await import("@openclaw/proc-safe/inspect");
    remaining(deadline);
    const command = readProcessCommand(pid);
    remaining(deadline);
    return command?.argv.join(" ") ?? "";
  } catch (cause) {
    throw failure(cause);
  }
}
