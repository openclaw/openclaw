/**
 * State the substrate carries with each chain so cap-on-enqueue can be
 * decided at the producer (back-pressure belongs at the producer, not the
 * wire — emitting-and-dropping at the collector still costs us the wire).
 */
export type ChainBudgetState = {
  /**
   * Remaining chain-step count for the current chain. `0` means the chain has
   * reached its budget and the substrate SHALL decline to carry trace context
   * past this point.
   */
  readonly chainStepBudgetRemaining: number;
};

/**
 * Cap-on-enqueue decision. `declineToCarry()` returns `true` when the chain
 * has reached its budget and the substrate SHOULD suppress queue-lifecycle
 * span emission for this entry.
 */
export const ChainBudget = Object.freeze({
  /**
   * Returns `true` when `chainStepBudgetRemaining <= 0`. When this returns
   * `true` the caller MUST suppress queue-lifecycle span emission for this
   * chain step and tick the `continuation.disabled` counter once so operators
   * can distinguish silenced-by-cap from never-emitted.
   *
   * `undefined` / non-finite remaining is treated as "no budget tracked yet" —
   * the chain has not opted in, so we do not decline.
   */
  declineToCarry(state: ChainBudgetState | undefined): boolean {
    if (!state) {
      return false;
    }
    const remaining = state.chainStepBudgetRemaining;
    if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
      return false;
    }
    return remaining <= 0;
  },
});

export type ChainBudget = typeof ChainBudget;
