import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { areDiagnosticsEnabledForProcess } from "./diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "./diagnostic-trace-context.js";
import { createFixedWindowBudget } from "./fixed-window-rate-limit.js";

const operations = {
  "ref-mutation": {
    stateKey: "openclaw.gitRefMutationDiagnostics",
    message: "slow Git ref mutation",
    phases: ["resolveMs", "queueWaitMs", "queuedOperationMs"],
  },
  "worktree-removal": {
    stateKey: "openclaw.worktreeRemovalDiagnostics",
    message: "slow managed worktree removal",
    phases: ["admissionMs", "bodyMs", "finalizeMs"],
  },
} as const;

const removalStages = [
  ["preparation", "preparationMs"],
  ["snapshot", "snapshotMs"],
  ["checkoutRemoval", "checkoutRemovalMs"],
  ["finalization", "bodyFinalizeMs"],
] as const;
type RemovalStage = (typeof removalStages)[number][0];

export function startGitOperationTiming(
  kind: keyof typeof operations,
  log: Pick<SubsystemLogger, "isEnabled" | "info">,
) {
  try {
    if (!areDiagnosticsEnabledForProcess() || !log.isEnabled("info")) {
      return undefined;
    }
    const startedAt = performance.now();
    const trace = getActiveDiagnosticTraceContext();
    const operation = operations[kind];
    let firstPhaseEnd: number | undefined;
    let secondPhaseEnd: number | undefined;
    let removalStage: RemovalStage | undefined;
    let removalStageStartedAt = 0;
    let removalDurations: Partial<Record<RemovalStage, number>> | undefined;
    return {
      markPhase() {
        if (firstPhaseEnd === undefined) {
          firstPhaseEnd = performance.now();
        } else {
          secondPhaseEnd = performance.now();
        }
      },
      markRemovalStage(next?: RemovalStage) {
        if (kind !== "worktree-removal") {
          return;
        }
        try {
          const now = performance.now();
          if (removalStage !== undefined) {
            removalDurations ??= {};
            removalDurations[removalStage] =
              (removalDurations[removalStage] ?? 0) + now - removalStageStartedAt;
          }
          removalStage = next;
          removalStageStartedAt = now;
        } catch {
          removalStage = undefined;
          removalDurations = undefined;
        }
      },
      finish(outcome: "returned" | "threw") {
        try {
          const endedAt = performance.now();
          const durationMs = endedAt - startedAt;
          if (durationMs < 1_000 || !areDiagnosticsEnabledForProcess() || !log.isEnabled("info")) {
            return;
          }
          const state = resolveGlobalSingleton(Symbol.for(operation.stateKey), () => ({
            budget: createFixedWindowBudget({
              maxRequests: 60,
              windowMs: 60_000,
              now: () => performance.now(),
            }),
            omitted: 0,
          }));
          if (!state.budget.consume().allowed) {
            state.omitted = Math.min(Number.MAX_SAFE_INTEGER, state.omitted + 1);
            return;
          }
          runWithDiagnosticTraceContext(trace, () =>
            log.info(operation.message, {
              pid: process.pid,
              threadId,
              isMainThread,
              durationMs: Math.round(durationMs),
              [operation.phases[0]]: Math.round((firstPhaseEnd ?? endedAt) - startedAt),
              ...(firstPhaseEnd !== undefined && secondPhaseEnd !== undefined
                ? {
                    [operation.phases[1]]: Math.round(secondPhaseEnd - firstPhaseEnd),
                    [operation.phases[2]]: Math.round(endedAt - secondPhaseEnd),
                  }
                : {}),
              ...Object.fromEntries(
                removalStages.flatMap(([stage, field]) => {
                  const elapsed = removalDurations?.[stage];
                  return elapsed === undefined ? [] : [[field, Math.round(elapsed)]];
                }),
              ),
              callbackEntered:
                (kind === "ref-mutation" ? secondPhaseEnd : firstPhaseEnd) !== undefined,
              outcome,
              omittedObservations: state.omitted,
            }),
          );
          state.omitted = 0;
        } catch {
          // Diagnostics must preserve the operation's result or original error.
        }
      },
    };
  } catch {
    return undefined;
  }
}
