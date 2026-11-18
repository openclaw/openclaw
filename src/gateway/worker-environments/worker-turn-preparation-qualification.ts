import { appendFileSync } from "node:fs";

// Disposable qualification only; never record turn, source, or error payloads.
export type WorkerPreparationPhase =
  | "transcript-import"
  | "transcript-admission"
  | "prepared-runtime"
  | "input-context"
  | "model"
  | "worker-connection"
  | "tool-authority"
  | "tool-surface"
  | "prompt"
  | "launch-input"
  | "launch-descriptor";

let preparationSequence = 0;
export function observeWorkerPreparation(enabled: boolean) {
  const directory = enabled ? process.env.OPENCLAW_QUALIFICATION_DIR : undefined;
  const preparationId = ++preparationSequence;
  let active: WorkerPreparationPhase | undefined;
  const phase = (next?: WorkerPreparationPhase) => {
    if (!directory || (!active && !next)) {
      return;
    }
    const at = Date.now();
    const cpu = process.cpuUsage();
    const record = (event: "phase-begin" | "phase-end", name: WorkerPreparationPhase) =>
      JSON.stringify({ event, preparationId, phase: name, at, cpu }) + "\n";
    const lines =
      (active ? record("phase-end", active) : "") + (next ? record("phase-begin", next) : "");
    active = next;
    try {
      appendFileSync(directory + "/worker-preparation-" + process.pid + ".jsonl", lines, {
        mode: 0o600,
      });
    } catch {
      // Missing observations must not replace the operation's original outcome.
    }
  };
  return { phase, [Symbol.dispose]: () => phase() };
}

// Disposable qualification only: observe the raw load, not its cancellation race.
let qualificationLoadSequence = 0;
export async function loadObservedWorkerTurnExecution<T>(
  loadWorkerTurnExecution: () => Promise<T>,
) {
  const directory = process.env.OPENCLAW_QUALIFICATION_DIR;
  if (!directory) {
    return loadWorkerTurnExecution();
  }
  const loadId = ++qualificationLoadSequence;
  const record = (event: "load-begin" | "load-end") => {
    try {
      appendFileSync(
        directory + "/worker-execution-load-" + process.pid + ".jsonl",
        JSON.stringify({
          event,
          loadId,
          at: Date.now(),
          cpu: process.cpuUsage(),
        }) + "\n",
        { mode: 0o600 },
      );
    } catch {
      // Observation must not replace the original load outcome.
    }
  };
  record("load-begin");
  return loadWorkerTurnExecution().finally(() => record("load-end"));
}
