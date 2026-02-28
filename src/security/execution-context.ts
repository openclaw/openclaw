/**
 * IBEL Phase 1 — Execution context builder.
 *
 * Bridges taint tracking into the tool validation layer. The context carries
 * aggregate taint level and optional field-level access for guards that need
 * granularity.
 */

import type { TaintTracker } from "./taint-tracker.js";
import { InstructionLevel } from "./types.js";
import type { ExecutionContext, TaintField } from "./types.js";

export type BuildExecutionContextParams = {
  activeTask?: string;
  sessionRole?: string;
  agentId?: string;
  sessionKey?: string;
  senderIsOwner?: boolean;
  taintTracker?: TaintTracker;
};

/**
 * Build an ExecutionContext from session metadata and an optional taint tracker.
 *
 * When no taint tracker is attached, aggregateTaintLevel defaults to SYSTEM —
 * this ensures backward compatibility (all guards return allow for untainted flows).
 */
export function buildExecutionContext(params: BuildExecutionContextParams): ExecutionContext {
  const { activeTask, sessionRole, agentId, sessionKey, senderIsOwner, taintTracker } = params;

  return {
    activeTask,
    sessionRole,
    aggregateTaintLevel: taintTracker?.getAggregateLevel() ?? InstructionLevel.SYSTEM,
    agentId,
    sessionKey,
    senderIsOwner,
    fieldTaint: taintTracker ? () => taintTracker.getFields() : undefined,
  };
}
