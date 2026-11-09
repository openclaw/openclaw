import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { inspectChildWaitState, isSupported, reapChild } from "@openclaw/proc-safe/reaper";
import { hasErrnoCode } from "../infra/errno.js";

type TrackedChild = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "once">;

const scheduledChildren = new WeakSet<TrackedChild>();
const groups = new Map<number, number>();
const EXIT_DELAY_MS = 25;
const POLL_INTERVAL_MS = 1_000;
const CLEANUP_DEADLINE_MS = 30_000;
let timer: NodeJS.Timeout | undefined;
let nextScanAt = 0;
let scanning = false;

function schedule(delay: number): void {
  const due = performance.now() + delay;
  if (timer && nextScanAt <= due) {
    return;
  }
  clearTimeout(timer);
  nextScanAt = due;
  timer = setTimeout(() => void tick(), delay).unref();
}

function onExit(): void {
  schedule(EXIT_DELAY_MS);
}

async function tick(): Promise<void> {
  timer = undefined;
  if (scanning) {
    schedule(EXIT_DELAY_MS);
    return;
  }
  scanning = true;
  try {
    for (const [rootPid, deadline] of groups) {
      if (performance.now() >= deadline) {
        groups.delete(rootPid);
        continue;
      }
      try {
        process.kill(-rootPid, 0);
      } catch (error) {
        // A live intermediate may still hold grandchildren we have not adopted.
        if (hasErrnoCode(error, "ESRCH")) {
          groups.delete(rootPid);
        }
      }
    }
    if (groups.size === 0) {
      return;
    }
    // Children can belong to any runtime thread. Enumerate our children once
    // for all terminating groups, never every process on the host per group.
    for (const thread of await readdir("/proc/self/task")) {
      let children: string;
      try {
        children = await readFile(`/proc/self/task/${thread}/children`, "utf8");
      } catch {
        continue;
      }
      for (const entry of children.trim().split(/\s+/u).filter(Boolean)) {
        const pid = Number(entry);
        let stat: string;
        try {
          stat = await readFile(`/proc/${pid}/stat`, "utf8");
        } catch {
          continue;
        }
        // A comm value may contain spaces or parentheses; fields follow its last ')'.
        const [state, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (
          !groups.has(Number(pgid)) ||
          pid === Number(pgid) ||
          Number(ppid) !== process.pid ||
          state !== "Z"
        ) {
          continue;
        }
        try {
          // Keep native initialization lazy and the final wait observation/reap synchronous.
          // libuv owns tracked roots; only adopted zombies in retained groups belong here.
          if (!isSupported()) {
            groups.clear();
            return;
          }
          if (inspectChildWaitState(pid).kind === "exited") {
            reapChild(pid);
          }
        } catch {
          // Retry transient native failures within the group's existing cleanup budget.
        }
      }
    }
  } catch {
    // Failure to enumerate children is not evidence that the groups are empty.
  } finally {
    scanning = false;
    if (groups.size > 0) {
      schedule(POLL_INTERVAL_MS);
    } else {
      clearTimeout(timer);
      timer = undefined;
      process.off("SIGCHLD", onExit);
    }
  }
}

/** Retain only the terminated group's adopted children after libuv consumes root exit. */
export function scheduleAdoptedChildZombieReapAfterExit(
  child: TrackedChild,
  usedProcessGroup: boolean,
  cleanupTimeoutMs = CLEANUP_DEADLINE_MS,
): void {
  if (
    process.platform !== "linux" ||
    !usedProcessGroup ||
    child.pid === undefined ||
    scheduledChildren.has(child)
  ) {
    return;
  }
  const rootPid = child.pid;
  scheduledChildren.add(child);
  const start = () => {
    if (groups.size === 0) {
      process.on("SIGCHLD", onExit);
    }
    groups.set(rootPid, performance.now() + Math.max(CLEANUP_DEADLINE_MS, cleanupTimeoutMs));
    onExit();
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    start();
  } else {
    child.once("exit", start);
  }
}
