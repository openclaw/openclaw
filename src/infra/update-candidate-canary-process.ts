import type { ChildProcess } from "node:child_process";
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

export async function terminateCanary(
  child: ChildProcess,
  closed: Promise<void>,
  deadline: number,
): Promise<boolean> {
  if (!child.pid) {
    return true;
  }
  const options = { detached: process.platform !== "win32" };
  const signal = (kind: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      signalProcessTree(child.pid!, kind, { ...options, onComplete: resolve });
    });
  const term = signal("SIGTERM");
  await waitBounded(
    Promise.all([term, closed]),
    Math.min(1_000, Math.max(0, deadline - Date.now())),
  );
  // A reaped group leader does not prove its descendants have exited.
  const outcome = await waitBounded(
    Promise.all([term, signal("SIGKILL"), closed]),
    Math.min(1_000, Math.max(0, deadline - Date.now())),
  );
  return outcome.status === "completed";
}
