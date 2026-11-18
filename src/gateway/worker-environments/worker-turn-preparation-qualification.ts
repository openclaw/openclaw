import { appendFileSync } from "node:fs";
import type {
  PreparedModelRuntimeLeaseOptions,
  PreparedModelRuntimeQualification,
} from "../../agents/prepared-model-runtime.types.js";

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
let acquisitionSequence = 0;
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
  const acquisition = (): PreparedModelRuntimeLeaseOptions["qualification"] => {
    if (!directory) {
      return undefined;
    }
    const acquisitionId = ++acquisitionSequence;
    return (attempt) => {
      // Each callback closes over its own attempt, including raw builds that outlive admission.
      const observations: {
        phase: Parameters<PreparedModelRuntimeQualification>[0];
        event: Parameters<PreparedModelRuntimeQualification>[1];
        value?: number | boolean;
        at: number;
        cpu: NodeJS.CpuUsage;
      }[] = [];
      const phaseCounts = {
        "borrow-check": { begun: 0, skipped: 0 },
        "shared-auth": { begun: 0, skipped: 0 },
        "replacement-wait": { begun: 0, skipped: 0 },
        "configured-owner-wait": { begun: 0, skipped: 0 },
        "metadata-resolve": { begun: 0, skipped: 0 },
        "derive-selections": { begun: 0, skipped: 0 },
        "owner-pending-wait": { begun: 0, skipped: 0 },
        publish: { begun: 0, skipped: 0 },
        "lease-finalize": { begun: 0, skipped: 0 },
        "previous-build-wait": { begun: 0, skipped: 0 },
        build: { begun: 0, skipped: 0 },
      };
      let count = 0;
      let settled = false;
      return (phaseName, event, value) => {
        try {
          // The selected worker path has at most two attempts and three replacement waits each.
          // A hard cap also bounds an unexpected route; the final allowed row declares truncation.
          if (count >= 96) {
            return;
          }
          count += 1;
          for (const [name, counts] of Object.entries(phaseCounts)) {
            if (name === phaseName) {
              counts.begun += event === "begin" ? 1 : 0;
              counts.skipped += event === "skip" ? 1 : 0;
            }
          }
          observations.push({
            phase: phaseName,
            event,
            value,
            at: Date.now(),
            cpu: process.cpuUsage(),
          });
          settled ||= (phaseName === "attempt" || phaseName === "lease") && event !== "begin";
          if (!settled && count !== 96) {
            return;
          }
          appendFileSync(
            directory + "/worker-acquisition-" + process.pid + ".jsonl",
            JSON.stringify({
              event: "acquisition-observation",
              pid: process.pid,
              preparationId,
              acquisitionId,
              attempt,
              truncated: count === 96,
              phaseCounts,
              observations,
            }) + "\n",
            { mode: 0o600 },
          );
          observations.length = 0;
        } catch {
          // Diagnostic sampling, encoding and sink failures never replace admission/build outcomes.
        }
      };
    };
  };
  return { phase, acquisition, [Symbol.dispose]: () => phase() };
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
