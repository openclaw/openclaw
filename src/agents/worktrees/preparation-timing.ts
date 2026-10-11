import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

type PreparationPhase =
  | "allocate"
  | "allocationWait"
  | "mutationWait"
  | "capacityWait"
  | "repository"
  | "sources"
  | "sourceRelease"
  | "leaseRelease"
  | "reservation"
  | "base"
  | "baseRefresh"
  | "baseHydration"
  | "baseFastForward"
  | "baseWait"
  | "diskAdmission"
  | "registration"
  | "provision"
  | "publication"
  | "indexRefresh"
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
  activePhases: number;
  coveredSince: number;
  coveredMs: number;
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
  if (current && current.activePhases++ === 0) {
    current.coveredSince = startedAt;
  }
  let finished = false;
  return () => {
    if (current && !finished) {
      const now = performance.now();
      current.phases[phase] = (current.phases[phase] ?? 0) + now - startedAt;
      if (--current.activePhases === 0) {
        current.coveredMs += now - current.coveredSince;
      }
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
    activePhases: 0,
    coveredSince: 0,
    coveredMs: 0,
  };
  let outcome = "threw";
  try {
    const result = await preparation.run(current, run);
    outcome = "returned";
    return result;
  } finally {
    if (current.enabled) {
      try {
        const end = performance.now();
        const durationMs = Math.round(end - start);
        const coveredMs =
          current.coveredMs + (current.activePhases ? end - current.coveredSince : 0);
        const unattributedMs = Math.round(Math.max(0, end - start - coveredMs));
        const phaseDurationsMs = Object.fromEntries(
          Object.entries(current.phases).map(([phase, duration]) => [phase, Math.round(duration)]),
        );
        log.info("managed worktree preparation", {
          consoleMessage: `managed worktree preparation kind=${kind} template=${current.template} outcome=${outcome} durationMs=${durationMs} unattributedMs=${unattributedMs} phaseDurationsMs=${JSON.stringify(phaseDurationsMs)}`,
          kind,
          template: current.template,
          outcome,
          durationMs,
          unattributedMs,
          phaseDurationsMs,
        });
        emit?.({
          name: "worktree.preparation",
          startedAt,
          endedAt: Date.now(),
          durationMs,
          details: {
            kind,
            template: current.template,
            outcome,
            unattributedMs,
            ...phaseDurationsMs,
          },
        });
      } catch {
        // Telemetry must preserve the preparation's result or original failure.
      }
    }
  }
}
