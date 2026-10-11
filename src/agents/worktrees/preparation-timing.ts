import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

type PreparationPhase =
  | "allocate"
  | "checkout"
  | "setup"
  | "templatePrepare"
  | "templateApply"
  | "snapshot"
  | "synchronizeCanonical"
  | "synchronizeProjection"
  | "containerStart"
  | "workspaceLayout";
type TemplateState = "warm" | "cold" | "unavailable" | "reused";
type PreparationTimingState = {
  enabled: boolean;
  template: TemplateState;
  phases: Partial<Record<PreparationPhase, number>>;
};
const log = createSubsystemLogger("agents/worktrees");
const preparation = new AsyncLocalStorage<PreparationTimingState>();

export function markManagedWorktreePreparation() {
  const current = preparation.getStore();
  if (current) {
    current.enabled = true;
  }
}

export function setWorktreePreparationTemplate(template: TemplateState) {
  const current = preparation.getStore();
  if (current) {
    current.template = template;
  }
}

/** Nested phases are inclusive; only total measures the complete preparation once. */
export function startWorktreePreparationPhase(phase: PreparationPhase) {
  const current = preparation.getStore();
  const startedAt = performance.now();
  let finished = false;
  return () => {
    if (current && !finished) {
      current.phases[phase] = (current.phases[phase] ?? 0) + performance.now() - startedAt;
      finished = true;
    }
  };
}

export async function timeWorktreePreparationPhase<T>(
  phase: PreparationPhase,
  run: () => Promise<T>,
): Promise<T> {
  const finish = startWorktreePreparationPhase(phase);
  try {
    return await run();
  } finally {
    finish();
  }
}

export async function withWorktreePreparationTiming<T>(
  kind: "managed" | "sandbox",
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const start = performance.now();
  const emit = createQueuedDiagnosticPhaseEmitter();
  const current: PreparationTimingState = {
    enabled: kind === "managed",
    template: "unavailable",
    phases: {},
  };
  let outcome = "threw";
  try {
    const result = await preparation.run(current, run);
    outcome = "returned";
    return result;
  } finally {
    if (current.enabled) {
      try {
        const durationMs = Math.round(performance.now() - start);
        const phaseDurationsMs = Object.fromEntries(
          Object.entries(current.phases).map(([phase, duration]) => [phase, Math.round(duration)]),
        );
        log.info("managed worktree preparation", {
          consoleMessage: `managed worktree preparation kind=${kind} template=${current.template} outcome=${outcome} durationMs=${durationMs} phaseDurationsMs=${JSON.stringify(phaseDurationsMs)}`,
          kind,
          template: current.template,
          outcome,
          durationMs,
          phaseDurationsMs,
        });
        emit?.({
          name: "worktree.preparation",
          startedAt,
          endedAt: Date.now(),
          durationMs,
          details: { kind, template: current.template, outcome, ...phaseDurationsMs },
        });
      } catch {
        // Telemetry must preserve the preparation's result or original failure.
      }
    }
  }
}
