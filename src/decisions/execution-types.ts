import type { DecisionReasoning } from "./input-types.js";

export type DecisionExecutionLifetime = {
  /** Composed by host from caller, per-call deadline, and retirement. */
  readonly signal: AbortSignal;
  /** Deadline on the same process-local performance.now() time base. */
  readonly deadlineMonotonicMs: number;
};

export type DecisionExecutionContext = DecisionExecutionLifetime & {
  /** Check synchronously at physical dispatch, including after DNS or worker queue waits.
   * False closes this request; a thrown caller authority assertion remains terminal. */
  readonly isAdmissible: () => boolean;
};

export type DecisionEvaluateOptions = {
  /** Omit for the default role; agent-owned work supplies its owner agent. */
  readonly agentId?: string;
  readonly purpose: string;
  /** Defaults to requested; optional work leaves capacity for requested evaluations. */
  readonly priority?: "requested" | "optional";
  readonly rubricVersion: string;
  /** Budget includes preparation; provider cleanup remains physically awaited. */
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
};

/** Adds only provider-declared reasoning to the established caller contract. */
export type DecisionEvaluateOptionsV2 = DecisionEvaluateOptions & {
  readonly reasoning?: DecisionReasoning | undefined;
};
