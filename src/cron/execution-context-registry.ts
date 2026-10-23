/**
 * Per-run lookup for the scheduled execution context. The admission owner binds
 * a context to its operational run instance; tool construction reads the
 * targets it needs. Leaf module: agent tools import it without cron's graph.
 */
import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import type { ScheduledExecutionContext } from "./scheduled-occurrence.js";

const contextsByRun = new WeakMap<OperationalRunInstanceRef, ScheduledExecutionContext>();

/** Admission-only: binds an occurrence's context to its admitted run. */
export function bindScheduledExecutionContext(
  run: OperationalRunInstanceRef,
  context: ScheduledExecutionContext,
): () => void {
  contextsByRun.set(run, context);
  return () => {
    if (contextsByRun.get(run) === context) {
      contextsByRun.delete(run);
    }
  };
}

/**
 * The session a scheduled run's board and widget tools act on, plus the
 * occurrence's assertion. Tools call `assertCurrent` before and inside each
 * effect so a reset or removed parent, or a settled run, refuses the write.
 */
export type ScheduledToolTargets = Readonly<{
  boardSessionKey: string;
  assertCurrent: () => void;
}>;

/**
 * Targets for the run its owner names (an admitted run context or tool options),
 * or undefined when that run was not admitted with an execution context.
 */
export function readScheduledToolTargets(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): ScheduledToolTargets | undefined {
  const run = owner?.operationalRunInstance;
  const context = run ? contextsByRun.get(run) : undefined;
  return context
    ? {
        boardSessionKey: context.resources.boardSessionKey,
        assertCurrent: context.assertCurrent,
      }
    : undefined;
}

/**
 * Tool-construction options for a scheduled run on a Gateway-resolved surface:
 * its targets, plus the grant's tool cap as the run's allowance, matching the
 * embedded attempt. Empty when the run was not admitted with a context.
 */
export function readScheduledToolOptions(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
  toolsAllow: readonly string[] | undefined,
): { scheduledToolTargets?: ScheduledToolTargets; runtimeToolAllowlist?: string[] } {
  const scheduledToolTargets = readScheduledToolTargets(owner);
  if (!scheduledToolTargets) {
    return {};
  }
  return { scheduledToolTargets, ...(toolsAllow ? { runtimeToolAllowlist: [...toolsAllow] } : {}) };
}
