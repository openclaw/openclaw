import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import {
  becomeChildSubreaper,
  inspectChildWaitState,
  isChildSubreaper,
  reapChild,
} from "@openclaw/proc-safe/reaper";
import { hasErrnoCode } from "../../infra/errno.js";

function childPids(): number[] {
  const children = new Set<number>();
  for (const thread of readdirSync("/proc/self/task")) {
    let value: string;
    try {
      value = readFileSync("/proc/self/task/" + thread + "/children", "utf8");
    } catch (error) {
      // A thread can retire during enumeration. This is not extinction evidence.
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    for (const pid of value.trim().split(/\s+/u).filter(Boolean)) {
      if (!/^\d+$/u.test(pid) || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) {
        throw new Error("Linux process owner could not enumerate its children");
      }
      children.add(Number(pid));
    }
  }
  return [...children];
}

/** One dedicated process acquires adoption before launching any application work. */
export function acquireLinuxChildSubreaper() {
  if (process.platform !== "linux" || process.versions.bun) {
    throw new Error("Linux child ownership requires the Node runtime");
  }
  if (/\.[cm]?ts$/u.test(new URL(import.meta.url).pathname)) {
    throw new Error(
      "Linux child ownership requires the built process owner, without a source loader",
    );
  }
  becomeChildSubreaper();
  if (!isChildSubreaper()) {
    throw new Error("Linux child ownership admission verification failed");
  }
  const libuvChildren = new Set<number>();
  const signaledChildren = new Map<number, "SIGTERM" | "SIGKILL">();
  const retainLibuvChild = (pid: number, child: Pick<ChildProcess, "pid" | "once">) => {
    if (child.pid !== pid || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Linux child ownership requires a spawned root");
    }
    libuvChildren.add(pid);
    // libuv reaps before emitting exit, in this same event-loop turn. Retire the
    // signal reservation here so a newly adopted reuse of this PID gets its own signal.
    child.once("exit", () => {
      libuvChildren.delete(pid);
      signaledChildren.delete(pid);
    });
  };
  // A loader thread can reap its compiler concurrently with this thread. That
  // would invalidate numeric-PID pinning. Admit only the dedicated built owner,
  // before its one libuv-owned application root has been spawned.
  if (childPids().length > 0) {
    throw new Error("Linux child ownership requires a dedicated owner without existing children");
  }
  let closed = false;
  return {
    retainLibuvChild,
    /** Discovery selects candidates; a retained kernel wait pins every signal target. */
    drain(signal?: "SIGTERM" | "SIGKILL"): boolean {
      if (closed) {
        return true;
      }
      for (const pid of childPids()) {
        // WNOWAIT retains wait ownership until the synchronous signal/reap completes.
        const state = inspectChildWaitState(pid);
        if (state.kind === "none") {
          continue;
        }
        const previousSignal = signaledChildren.get(pid);
        if (
          state.kind === "running" &&
          signal &&
          previousSignal !== signal &&
          previousSignal !== "SIGKILL"
        ) {
          try {
            // No await, reap, or event-loop callback may cross this ownership/signal pair.
            process.kill(pid, signal);
          } catch (error) {
            if (!hasErrnoCode(error, "ESRCH")) {
              throw error;
            }
          }
          signaledChildren.set(pid, signal);
        }
        if (state.kind === "exited" && !libuvChildren.has(pid) && reapChild(pid)) {
          signaledChildren.delete(pid);
        }
      }
      // Only ECHILD proves extinction; running and retained exit statuses do not.
      if (inspectChildWaitState().kind !== "none") {
        return false;
      }
      closed = true;
      return true;
    },
  };
}
