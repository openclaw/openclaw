import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { sleepWithAbort } from "@openclaw/retry";
import { hasErrnoCode } from "../infra/errno.js";
import { getProcessInstanceStartTime, isPidDefinitelyDead } from "../shared/pid-alive.js";
import { readDarwinProcessCommand } from "./supervisor/darwin-process-command.js";

type ProcessRow = { pid: number; parentPid: number; uid: number; command: string };
type CapturedProcess = ProcessRow & { startedAt: number; argv: string[] };

function readProcessCwd(pid: number): string {
  const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F0n"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const paths = output.split("\0").filter((field) => field.startsWith("n"));
  if (paths.length !== 1 || !paths[0]) {
    throw new Error(
      `Cannot inspect orphaned process ${pid}'s working directory; inspect it before retrying.`,
    );
  }
  return paths[0].slice(1);
}

function readProcesses(pid?: number): ProcessRow[] {
  let output: string;
  try {
    output = execFileSync(
      "/bin/ps",
      [...(pid === undefined ? ["-A"] : ["-p", String(pid)]), "-o", "pid=,ppid=,uid=,comm="],
      {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch (error) {
    if (pid !== undefined && isPidDefinitelyDead(pid)) {
      return [];
    }
    throw error;
  }
  return output.split("\n").flatMap((line) => {
    const [, processId, parentPid, uid, command] =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line) ?? [];
    return command
      ? [
          {
            pid: Number(processId),
            parentPid: Number(parentPid),
            uid: Number(uid),
            command: command.trim(),
          },
        ]
      : [];
  });
}

function captureProcess(
  row: ProcessRow,
  command: string,
  matchesArguments?: (argv: readonly string[]) => boolean,
  cwd?: string,
): CapturedProcess | undefined {
  if (row.uid !== process.getuid?.() || row.command !== command) {
    return undefined;
  }
  try {
    const startedAt = getProcessInstanceStartTime(row.pid);
    const observed = readDarwinProcessCommand(row.pid, row.uid);
    if (
      !observed ||
      !("argv" in observed) ||
      observed.executable !== command ||
      observed.argv[0] !== command ||
      (matchesArguments && !matchesArguments(observed.argv))
    ) {
      return undefined;
    }
    if (cwd !== undefined && readProcessCwd(row.pid) !== cwd) {
      return undefined;
    }
    if (startedAt === null) {
      throw new Error(
        `Cannot verify orphaned process ${row.pid}; stop it manually before retrying.`,
      );
    }
    if (getProcessInstanceStartTime(row.pid) !== startedAt) {
      return undefined;
    }
    return { ...row, startedAt, argv: observed.argv };
  } catch (error) {
    if (isPidDefinitelyDead(row.pid)) {
      return undefined;
    }
    throw error;
  }
}

function isCapturedProcessAlive(target: CapturedProcess): boolean {
  if (isPidDefinitelyDead(target.pid)) {
    return false;
  }
  const current = getProcessInstanceStartTime(target.pid);
  // Unknown identity retains cleanup responsibility but cannot authorize a signal.
  return current === null || current === target.startedAt;
}

/** Reclaim a launchd-adopted tree while its captured executable and birth still match. */
export async function reapOrphanedProcesses(params: {
  command: string;
  matchesArguments: (argv: readonly string[]) => boolean;
  cwd?: string;
  signal?: AbortSignal;
  onReap?: (pid: number) => void;
}): Promise<number[]> {
  params.signal?.throwIfAborted();
  // Linux PID 1 can itself be a live Gateway; PPID 1 does not establish orphanhood there.
  if (process.platform !== "darwin" || getProcessInstanceStartTime(process.pid) === null) {
    return [];
  }
  const cwd = params.cwd === undefined ? undefined : realpathSync(params.cwd);
  const rows = readProcesses();
  const roots = rows
    .filter((row) => row.parentPid === 1 && row.pid !== process.pid)
    .map((row) => captureProcess(row, params.command, params.matchesArguments, cwd))
    .filter((row) => row !== undefined);
  const reaped: number[] = [];
  for (const root of roots) {
    const captured = new Map<number, CapturedProcess>([[root.pid, root]]);
    // Preserve the original descendants; never rediscover a tree after its leader exits.
    for (let size = 0; size !== captured.size;) {
      size = captured.size;
      for (const row of rows) {
        const parent = captured.get(row.parentPid);
        if (captured.has(row.pid) || !parent || !isCapturedProcessAlive(parent)) {
          continue;
        }
        const current = readProcesses(row.pid)[0];
        const child = current?.parentPid === parent.pid && captureProcess(current, params.command);
        if (child && getProcessInstanceStartTime(parent.pid) === parent.startedAt) {
          captured.set(child.pid, child);
        }
      }
    }
    const canSignal = (target: CapturedProcess) => {
      if (!isCapturedProcessAlive(target)) {
        return false;
      }
      const row = readProcesses(target.pid)[0];
      const current =
        row &&
        captureProcess(row, params.command, undefined, target.pid === root.pid ? cwd : undefined);
      if (!isCapturedProcessAlive(target)) {
        return false;
      }
      if (
        !current ||
        current.startedAt !== target.startedAt ||
        current.argv.length !== target.argv.length ||
        current.argv.some((value, index) => value !== target.argv[index]) ||
        (current.parentPid !== target.parentPid && current.parentPid !== 1) ||
        (target.pid === root.pid && !params.matchesArguments(current.argv))
      ) {
        throw new Error(`Orphaned process ${target.pid} changed identity; refusing to signal it.`);
      }
      return true;
    };
    const failures: unknown[] = [];
    let signalAttempted = false;
    const signalCaptured = (target: CapturedProcess, signal: "SIGTERM" | "SIGKILL") => {
      try {
        if (canSignal(target)) {
          if (!signalAttempted) {
            params.signal?.throwIfAborted();
          }
          signalAttempted = true;
          process.kill(target.pid, signal);
        }
      } catch (error) {
        if (!signalAttempted) {
          throw error;
        }
        if (!hasErrnoCode(error, "ESRCH")) {
          failures.push(error);
        }
      }
    };
    const alive = () => [...captured.values()].filter(isCapturedProcessAlive);
    const waitForExit = async () => {
      const deadline = Date.now() + 5_000;
      while (alive().length > 0 && Date.now() < deadline) {
        await sleepWithAbort(Math.min(25, deadline - Date.now()));
      }
    };
    params.signal?.throwIfAborted();
    params.onReap?.(root.pid);
    params.signal?.throwIfAborted();
    // A vanished, recycled, or newly supervised root cannot authorize its former tree.
    signalCaptured(root, "SIGTERM");
    if (!signalAttempted) {
      continue;
    }
    for (const target of captured.values()) {
      if (target.pid !== root.pid) {
        signalCaptured(target, "SIGTERM");
      }
    }
    // Once TERM has been attempted, cancellation must join this captured tree's cleanup.
    await waitForExit();
    for (const target of alive()) {
      signalCaptured(target, "SIGKILL");
    }
    await waitForExit();
    if (alive().length > 0) {
      failures.push(new Error(`Orphaned process tree ${root.pid} did not stop; stop it manually.`));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Could not safely stop orphaned process tree ${root.pid}.`,
      );
    }
    reaped.push(root.pid);
    params.signal?.throwIfAborted();
  }
  return reaped;
}
