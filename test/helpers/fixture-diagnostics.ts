import type { ChildProcess } from "node:child_process";
import { closeSync, openSync, opendirSync, readSync } from "node:fs";

const MAX_RECORDS = 48;
const MAX_PROCESSES = 16;
const MAX_THREADS_PER_PROCESS = 16;
const label = (value: string) => value.slice(0, 96);

function readProcFile(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    return buffer.toString("utf8", 0, readSync(fd, buffer));
  } catch {
    // A process may exit during the snapshot; diagnostics must not block cleanup.
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function captureLinuxProcessTree(pid: number | undefined) {
  if (process.platform !== "linux" || pid === undefined || pid <= 0) {
    return undefined;
  }
  const pending = [pid];
  const seen = new Set(pending);
  const processes: Array<{
    pid: number;
    parentPid?: number;
    category?: "node" | "npm" | "esbuild" | "other";
    unavailable?: boolean;
    threads: Array<{ tid: number; state?: string; waitChannel?: string }>;
  }> = [];
  let truncated = false;
  for (const currentPid of pending) {
    const root = `/proc/${currentPid}`;
    const threads: (typeof processes)[number]["threads"] = [];
    const entry: (typeof processes)[number] = { pid: currentPid, threads };
    processes.push(entry);
    const comm = readProcFile(`${root}/comm`)?.trim();
    // Only fixed categories escape this helper; process titles can contain arguments.
    entry.category =
      comm?.startsWith("npm ") || comm === "npm"
        ? "npm"
        : comm === "node" || comm === "MainThread"
          ? "node"
          : comm === "esbuild"
            ? "esbuild"
            : "other";
    let directory: ReturnType<typeof opendirSync> | undefined;
    try {
      directory = opendirSync(`${root}/task`);
      for (let item = directory.readSync(); item; item = directory.readSync()) {
        if (!/^\d+$/u.test(item.name)) {
          continue;
        }
        if (threads.length === MAX_THREADS_PER_PROCESS) {
          truncated = true;
          break;
        }
        const tid = Number(item.name);
        const taskRoot = `${root}/task/${tid}`;
        const stat = readProcFile(`${taskRoot}/stat`);
        const fields = stat?.slice(stat.lastIndexOf(")") + 2).split(" ");
        const state = fields?.[0];
        const waitChannel = readProcFile(`${taskRoot}/wchan`)?.trim();
        threads.push({
          tid,
          state: state && /^[A-Z]$/u.test(state) ? state : undefined,
          waitChannel:
            waitChannel && /^[A-Za-z0-9_]{1,96}$/u.test(waitChannel) ? waitChannel : undefined,
        });
        if (tid === currentPid && fields?.[1] && /^\d+$/u.test(fields[1])) {
          entry.parentPid = Number(fields[1]);
        }
        const children = readProcFile(`${taskRoot}/children`);
        for (const child of children?.trim().split(/\s+/u) ?? []) {
          if (!/^\d+$/u.test(child)) {
            continue;
          }
          const childPid = Number(child);
          if (seen.has(childPid)) {
            continue;
          }
          if (seen.size === MAX_PROCESSES) {
            truncated = true;
            break;
          }
          seen.add(childPid);
          pending.push(childPid);
        }
      }
    } catch {
      entry.unavailable = true;
    } finally {
      directory?.closeSync();
    }
  }
  return { processes, truncated };
}

type ChildObservation = Pick<ChildProcess, "pid" | "exitCode" | "signalCode"> & {
  stdout: { closed: boolean } | null;
  stderr: { closed: boolean } | null;
  once(event: "spawn" | "exit" | "close", listener: () => void): unknown;
};

/** Failure-only metadata; never retain command arguments, environment, paths, or output. */
export function createFixtureDiagnostics(name: string) {
  const startedAt = performance.now();
  const records: object[] = [];
  let dropped = 0;
  let sequence = 0;
  let stage = "setup";
  let reported = false;
  let current: (() => object) | undefined;
  const elapsed = () => Math.round(performance.now() - startedAt);
  const record = (value: object) => {
    if (records.length === MAX_RECORDS) {
      records.shift();
      dropped++;
    }
    records.push(value);
  };

  return {
    stage(value: string) {
      stage = label(value);
      record({ event: "stage", stage, elapsedMs: elapsed() });
    },
    command(role: string, hasInput = false) {
      const commandStartedAt = performance.now();
      const id = ++sequence;
      const commandStage = stage;
      const commandRole = label(role);
      let child: ChildObservation | undefined;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let input = hasInput ? "pending" : "not-applicable";
      let errorCode: string | undefined;
      const snapshot = (event: string) => ({
        event,
        id,
        role: commandRole,
        stage: commandStage,
        elapsedMs: elapsed(),
        commandElapsedMs: Math.round(performance.now() - commandStartedAt),
        pid: child?.pid,
        exitCode: child?.exitCode,
        signalCode: child?.signalCode,
        stdoutClosed: child?.stdout?.closed,
        stderrClosed: child?.stderr?.closed,
        stdoutBytes,
        stderrBytes,
        input,
        errorCode,
      });
      const event = (value: string) => record(snapshot(value));
      current = () => ({
        ...snapshot("current"),
        processTree:
          child?.exitCode === null && child.signalCode === null
            ? captureLinuxProcessTree(child.pid)
            : undefined,
      });
      event("command-start");
      return {
        ready(value: ChildObservation) {
          child = value;
          event("on-ready");
          // The owner installs capture and lifecycle handlers first. These only observe.
          for (const eventName of ["spawn", "exit", "close"] as const) {
            child.once(eventName, () => event(eventName));
          }
        },
        output(stream: "stdout" | "stderr", bytes: number) {
          if (stream === "stdout") {
            stdoutBytes += bytes;
          } else {
            stderrBytes += bytes;
          }
        },
        settled(error?: unknown) {
          if (error && typeof error === "object" && "code" in error) {
            const code = error.code;
            if (typeof code === "string" && /^[A-Z_0-9]{1,48}$/u.test(code)) {
              errorCode = code;
            }
          }
          event("managed-settled");
        },
        inputComplete() {
          if (hasInput) {
            input = "settled";
          }
          event("input-complete");
        },
      };
    },
    report(reason: "failure" | "abort") {
      if (reported) {
        return;
      }
      reported = true;
      console.error(
        "[fixture-lifecycle] " +
          JSON.stringify({
            name: label(name),
            reason,
            stage,
            dropped,
            records,
            current: current?.(),
          }),
      );
    },
  };
}

export type FixtureDiagnostics = ReturnType<typeof createFixtureDiagnostics>;
