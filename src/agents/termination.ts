/**
 * Composable termination conditions for A2A agent loops.
 *
 * The OR/AND combinators are well-known in reactive programming (RxJS, CSP).
 * The novelty here is their application to *agent loop termination* specifically:
 *
 *   1. Conditions are Awaitable — scorers can be async LLM calls.
 *   2. Signals are semantic, not just events: grounded output, text mention,
 *      elapsed time, pattern match — not raw stream events.
 *   3. The GSAR integration (GroundednessCondition) composes grounding scores
 *      directly into the termination decision, turning hallucination detection
 *      into a first-class loop exit condition.
 *
 * Soft conditions (TextMention, ReplyPattern, TimeLimit) fire based on
 * observable signals and are non-deterministic — the LLM may or may not
 * produce them. Hard conditions (MaxIterations) always fire and guarantee
 * bounded execution. The correct pattern is:
 *
 *   soft_signal.or(MaxIterations(K_max))
 *
 * This encodes the K_max safety bound from GSAR (arxiv:2604.23366, §3.2):
 * termination is guaranteed regardless of model behaviour.
 */

export type TerminationState = {
  /** 1-based turn number. */
  turn: number;
  /** Text content of the latest assistant reply. */
  replyText: string;
  /** Timestamp when the loop started (Date.now()). */
  startedAt: number;
};

/** Allows check() to return either a value or a promise — sync conditions stay fast. */
export type Awaitable<T> = T | PromiseLike<T>;

export abstract class TerminationCondition {
  abstract check(state: TerminationState): Awaitable<readonly [boolean, string | null]>;

  /** Reset any internal state between loop runs. */
  reset(): void {}

  /** Stop if either condition is met (OR). */
  or(other: TerminationCondition): TerminationCondition {
    return new OrCondition([this, other]);
  }

  /** Stop only when all conditions are met simultaneously (AND). */
  and(other: TerminationCondition): TerminationCondition {
    return new AndCondition([this, other]);
  }
}

// ─── Composites ─────────────────────────────────────────────────────────────

export class OrCondition extends TerminationCondition {
  constructor(private readonly conditions: readonly TerminationCondition[]) {
    super();
  }

  async check(state: TerminationState): Promise<readonly [boolean, string | null]> {
    for (const cond of this.conditions) {
      const [stop, reason] = await cond.check(state);
      if (stop) {
        return [true, reason];
      }
    }
    return [false, null];
  }

  reset(): void {
    for (const cond of this.conditions) {
      cond.reset();
    }
  }
}

export class AndCondition extends TerminationCondition {
  constructor(private readonly conditions: readonly TerminationCondition[]) {
    super();
  }

  async check(state: TerminationState): Promise<readonly [boolean, string | null]> {
    const reasons: string[] = [];
    for (const cond of this.conditions) {
      const [stop, reason] = await cond.check(state);
      if (!stop) {
        return [false, null];
      }
      if (reason) {
        reasons.push(reason);
      }
    }
    return [true, reasons.join(" AND ") || "all_conditions_met"];
  }

  reset(): void {
    for (const cond of this.conditions) {
      cond.reset();
    }
  }
}

// ─── Hard conditions (always fire — safety bounds) ───────────────────────────

/** Stop after N turns. Always fires — guarantees bounded execution. */
export class MaxIterations extends TerminationCondition {
  constructor(private readonly max: number) {
    super();
  }

  check(state: TerminationState): readonly [boolean, string | null] {
    return state.turn >= this.max ? [true, "max_iterations"] : [false, null];
  }
}

/** Stop after a wall-clock duration. Resets on each loop run. */
export class TimeLimit extends TerminationCondition {
  private startedAt: number | null = null;

  constructor(private readonly seconds: number) {
    super();
  }

  check(state: TerminationState): readonly [boolean, string | null] {
    if (this.startedAt === null) {
      this.startedAt = state.startedAt;
    }
    return Date.now() - this.startedAt >= this.seconds * 1000
      ? [true, "time_limit"]
      : [false, null];
  }

  reset(): void {
    this.startedAt = null;
  }
}

// ─── Soft conditions (event-driven — non-deterministic) ──────────────────────

/**
 * Stop when the assistant reply contains a specific string.
 *
 * Non-deterministic: the model may or may not produce the text.
 * Always pair with a hard bound: TextMention("DONE").or(MaxIterations(N))
 */
export class TextMention extends TerminationCondition {
  constructor(
    private readonly text: string,
    private readonly caseSensitive = false,
  ) {
    super();
  }

  check(state: TerminationState): readonly [boolean, string | null] {
    const haystack = this.caseSensitive ? state.replyText : state.replyText.toLowerCase();
    const needle = this.caseSensitive ? this.text : this.text.toLowerCase();
    return haystack.includes(needle) ? [true, `text_mention:${this.text}`] : [false, null];
  }
}

/**
 * Stop when the reply matches a regex pattern.
 *
 * Non-deterministic. Pair with a hard bound.
 */
export class ReplyPattern extends TerminationCondition {
  constructor(private readonly pattern: RegExp) {
    super();
  }

  check(state: TerminationState): readonly [boolean, string | null] {
    // Reset lastIndex so global/sticky regexes don't alternate true/false across calls.
    this.pattern.lastIndex = 0;
    return this.pattern.test(state.replyText)
      ? [true, `reply_pattern:${this.pattern.source}`]
      : [false, null];
  }
}

/**
 * Stop based on a custom predicate.
 *
 * Example:
 *   new CustomCondition(s => [s.turn > 2 && s.replyText.length < 200, "short_reply"])
 */
export class CustomCondition extends TerminationCondition {
  constructor(private readonly fn: (state: TerminationState) => readonly [boolean, string | null]) {
    super();
  }

  check(state: TerminationState): readonly [boolean, string | null] {
    return this.fn(state);
  }
}

// ─── Functional helpers ──────────────────────────────────────────────────────

/** Stop if any condition is met. Functional alias for `.or()`. */
export function any(...conditions: TerminationCondition[]): TerminationCondition {
  return new OrCondition(conditions);
}

/** Stop only when all conditions are met. Functional alias for `.and()`. */
export function all(...conditions: TerminationCondition[]): TerminationCondition {
  return new AndCondition(conditions);
}
