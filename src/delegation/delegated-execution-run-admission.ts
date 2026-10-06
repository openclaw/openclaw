/**
 * Host admission gates wired into the real execution paths.
 *
 * Both gates are scoped to executions whose delegated task lineage the Host has
 * proven with `bindDelegatedExecutionLineage`. An execution with no proven
 * relation is unrelated by construction and stays DIRECT; an execution whose
 * lineage is reserved by delegated work is denied, and stays denied when the
 * registry cannot be read.
 */
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  resolveDelegatedExecutionFallbackAuthority,
  resolveDelegatedExecutionLineage,
} from "./delegated-execution-lineage.js";
import {
  admitAgentExecution,
  admitToolExecution,
  type DelegatedExecutionAdmission,
} from "./delegated-execution-ownership-guard.js";

export class DelegatedExecutionDeniedError extends Error {
  readonly code: string;
  readonly delegationRef: string | null;
  constructor(decision: Extract<DelegatedExecutionAdmission, { allowed: false }>) {
    super(decision.reason);
    this.name = "DelegatedExecutionDeniedError";
    this.code = decision.code;
    this.delegationRef = decision.delegationRef;
  }
}

export type DelegatedExecutionGateParams = Readonly<{
  contexts: readonly (unknown | undefined)[];
  options?: OpenClawStateDatabaseOptions;
}>;

/**
 * A) Ordinary agent/model execution gate.
 *
 * Runs before the run is admitted and therefore before any model work. Throws
 * when delegated work still owns the proven lineage.
 */
export function assertDelegatedExecutionAgentAdmission(params: DelegatedExecutionGateParams): void {
  const lineageRef = resolveDelegatedExecutionLineage(params.contexts);
  if (!lineageRef) {
    return;
  }
  const fallbackAuthority = resolveDelegatedExecutionFallbackAuthority(params.contexts);
  const decision = admitAgentExecution({
    lineageRef,
    ...(fallbackAuthority === undefined ? {} : { fallbackAuthority }),
    ...(params.options ? { options: params.options } : {}),
  });
  if (!decision.allowed) {
    throw new DelegatedExecutionDeniedError(decision);
  }
}

/**
 * B) Tool/capability execution gate.
 *
 * Repeated before a protected tool executes. Returns a denial reason instead of
 * throwing so the before_tool_call policy chain can veto the call with a typed
 * outcome.
 */
export function describeDelegatedExecutionToolDenial(
  params: DelegatedExecutionGateParams,
): string | undefined {
  const lineageRef = resolveDelegatedExecutionLineage(params.contexts);
  if (!lineageRef) {
    return undefined;
  }
  const fallbackAuthority = resolveDelegatedExecutionFallbackAuthority(params.contexts);
  const decision = admitToolExecution({
    lineageRef,
    ...(fallbackAuthority === undefined ? {} : { fallbackAuthority }),
    ...(params.options ? { options: params.options } : {}),
  });
  return decision.allowed ? undefined : decision.reason;
}

export { resolveDelegatedExecutionLineage };
