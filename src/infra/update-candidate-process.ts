import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { isChildProcessTreeAlive, signalChildProcessTree } from "../process/child-process-tree.js";
import { signalProcessTree } from "../process/kill-tree.js";

export async function waitBounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<{ status: "completed"; value: T } | { status: "deadline" | "aborted" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ status: "completed" as const, value })),
      new Promise<{ status: "deadline" | "aborted" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "deadline" }), Math.max(0, milliseconds));
        abort = () => resolve({ status: "aborted" });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) {
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function waitForCanaryProcessTreeExit(
  child: ChildProcess,
  deadline: number,
): Promise<boolean> {
  while (isChildProcessTreeAlive(child)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await sleep(Math.min(25, remaining));
  }
  return true;
}

export async function terminateCanary(
  child: ChildProcess,
  closed: Promise<unknown>,
  deadline: number,
): Promise<void> {
  if (!child.pid) {
    return;
  }
  const pid = child.pid;
  // Validation may exhaust its deadline while unwinding. Teardown still needs
  // a bounded scheduling window to observe forced exit and adopted-child reaping.
  const cleanupDeadline = Math.max(deadline, Date.now() + 1_000);
  const options = { detached: process.platform !== "win32" };
  const signal = (kind: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      if (options.detached) {
        signalChildProcessTree(child, kind);
        resolve();
      } else {
        signalProcessTree(pid, kind, { ...options, onComplete: resolve });
      }
    });
  // Reserve time for forced termination even when little of the common budget remains.
  const remaining = Math.max(0, cleanupDeadline - Date.now());
  const termDeadline = Date.now() + Math.min(1_000, options.detached ? remaining / 2 : remaining);
  await waitBounded(
    Promise.all([signal("SIGTERM"), closed]),
    Math.max(0, termDeadline - Date.now()),
  );
  // A reaped group leader does not prove its descendants have exited.
  if (options.detached && (await waitForCanaryProcessTreeExit(child, termDeadline))) {
    return;
  }
  const killDeadline = Math.min(cleanupDeadline, Date.now() + 1_000);
  await waitBounded(
    Promise.all([signal("SIGKILL"), closed]),
    Math.max(0, killDeadline - Date.now()),
  );
  // Unix requires group extinction; Windows can at least refuse a still-live root
  // after taskkill's callback or the bounded wait. Neither signal delivery nor timeout proves exit.
  if (!(await waitForCanaryProcessTreeExit(child, killDeadline))) {
    throw new Error("Candidate process tree did not exit before cleanup deadline");
  }
}
