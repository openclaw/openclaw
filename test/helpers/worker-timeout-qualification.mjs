// Disposable incident instrumentation; never imported outside the qualification overlay.
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const now = Date.now;
const phases = new Set([
  "begin",
  "seed-ready",
  "launch-enter",
  "reply-appended",
  "reconcile-enter",
  "execute-first",
  "first-durable",
  "execute-followup",
  "reconcile-release",
  "reconcile-released",
  "wait-run-end",
  "followup-durable",
  "run-ended",
  "cleanup-enter",
  "cleanup-complete",
]);

export function observeWorkerTimeout(signal, outcome) {
  const directory = process.env.OPENCLAW_QUALIFICATION_DIR;
  if (!directory || !["accepted", "conflict", "failure"].includes(outcome)) {
    throw new Error("Qualification output directory and fixed case identity are required");
  }
  const file = path.join(directory, "worker-phases-" + process.pid + ".jsonl");
  const startedAt = now();
  let phase = "begin";
  const emit = (event, extra = {}) => {
    try {
      appendFileSync(
        file,
        JSON.stringify({
          at: now(),
          startedAt,
          pid: process.pid,
          outcome,
          event,
          phase,
          ...extra,
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      // Observation never replaces the original test error or settlement.
      process.stderr.write("[qualification] phase output unavailable\n");
    }
  };
  const project = (report) => ({
    threadId: report.header?.threadId,
    // Omit message, argv, environment, endpoint and arbitrary handle fields.
    javascriptStack: report.javascriptStack?.stack?.slice(0, 32),
    nativeStack: report.nativeStack?.slice(0, 32).map(({ pc, symbol }) => ({ pc, symbol })),
    libuv: report.libuv
      ?.slice(0, 64)
      .map(({ type, is_active, is_referenced }) => ({ type, is_active, is_referenced })),
    workers: report.workers?.slice(0, 32).map(project),
  });
  const abort = () => {
    emit("signal-abort");
    try {
      // Synchronous projection runs at signal delivery, before asynchronous cleanup.
      // A blocked event loop delays this callback: the external sampler remains independent.
      emit("signal-report", { report: project(process.report.getReport()) });
    } catch {
      emit("signal-report-unavailable");
    }
  };
  const wait = Atomics.wait;
  const waitFile = path.join(directory, "synchronous-wait-" + process.pid + ".json");
  Atomics.wait = function (...args) {
    try {
      writeFileSync(
        waitFile,
        JSON.stringify({
          pid: process.pid,
          at: now(),
          phase,
          operation: "Atomics.wait",
          timeoutMs: Number.isFinite(args[3]) ? args[3] : null,
          stack: new Error().stack?.split("\n").slice(1, 9),
        }),
        { mode: 0o600 },
      );
    } catch {
      /* Observation must not change the synchronous wait. */
    }
    try {
      return Reflect.apply(wait, this, args);
    } finally {
      try {
        unlinkSync(waitFile);
      } catch {
        /* Already collected or unavailable. */
      }
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  emit("phase");
  return (next) => {
    if (!phases.has(next)) throw new Error("Unknown qualification phase");
    phase = next;
    emit("phase");
    if (next === "cleanup-complete") {
      signal.removeEventListener("abort", abort);
      Atomics.wait = wait;
    }
  };
}
