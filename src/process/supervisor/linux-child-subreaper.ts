import type { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hasErrnoCode } from "../../infra/errno.js";

const PR_SET_CHILD_SUBREAPER = 36;
const PR_GET_CHILD_SUBREAPER = 37;
const P_ALL = 0;
const P_PID = 1;
const WNOHANG = 1;
const WEXITED = 4;
const WNOWAIT = 0x0100_0000;
// Non-SIGCHLD clone children are otherwise invisible to an ECHILD observation.
const WALL = 0x4000_0000;
const ECHILD = 10;
const EINTR = 4;

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
  // This module is host-owned, never a native dependency of the portable worker archive.
  const koffi: typeof import("koffi").default = createRequire(import.meta.url)("koffi");
  const libc = koffi.load(null);
  const prctl = libc.func(
    "int prctl(int, unsigned long, unsigned long, unsigned long, unsigned long)",
  );
  const getSubreaper = libc.func(
    "int prctl(int, _Out_ int *, unsigned long, unsigned long, unsigned long)",
  );
  // Linux permits a null siginfo pointer. WNOWAIT checks wait ownership without
  // consuming libuv's direct-child status or releasing an adopted child's PID.
  const waitid = libc.func("int waitid(int, unsigned int, void *, int)");
  const waitpid = libc.func("int waitpid(int, int *, int)");
  const fail = (operation: string, errno = koffi.errno()): never => {
    throw new Error("Linux child ownership " + operation + " failed (errno " + errno + ")");
  };
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) !== 0) {
    fail("admission");
  }
  const admitted = [0];
  if (getSubreaper(PR_GET_CHILD_SUBREAPER, admitted, 0, 0, 0) !== 0 || admitted[0] !== 1) {
    fail("admission verification");
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
  const owns = (pid: number): boolean => {
    for (;;) {
      if (waitid(P_PID, pid, null, WEXITED | WNOHANG | WNOWAIT | WALL) === 0) {
        return true;
      }
      const errno = koffi.errno();
      if (errno === ECHILD) {
        return false;
      }
      if (errno !== EINTR) {
        fail("child wait", errno);
      }
    }
  };
  return {
    retainLibuvChild,
    /** Discovery selects candidates; a retained kernel wait pins every signal target. */
    drain(signal?: "SIGTERM" | "SIGKILL"): boolean {
      if (closed) {
        return true;
      }
      for (const pid of childPids()) {
        if (!owns(pid)) {
          continue;
        }
        const previousSignal = signaledChildren.get(pid);
        if (signal && previousSignal !== signal && previousSignal !== "SIGKILL") {
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
        if (libuvChildren.has(pid)) {
          continue;
        }
        const reaped = waitpid(pid, null, WNOHANG | WALL);
        if (reaped === pid) {
          signaledChildren.delete(pid);
        } else if (reaped < 0) {
          const errno = koffi.errno();
          if (errno === ECHILD) {
            signaledChildren.delete(pid);
          } else if (errno !== EINTR) {
            fail("adopted child reap", errno);
          }
        }
      }
      if (waitid(P_ALL, 0, null, WEXITED | WNOHANG | WNOWAIT | WALL) === 0) {
        return false;
      }
      const errno = koffi.errno();
      if (errno === EINTR) {
        return false;
      }
      if (errno !== ECHILD) {
        fail("extinction observation", errno);
      }
      closed = true;
      return true;
    },
  };
}
