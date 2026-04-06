/**
 * @fileoverview Intent classification engine for OpenClaw message routing.
 *
 * Classifies incoming messages by complexity using local heuristics — no LLM
 * calls, no network requests, no side effects. The classifier evaluates a
 * configurable rule chain where each rule has a category, priority, and a set
 * of matchers. Rules are evaluated in priority order (lowest number first);
 * the first rule whose matchers ALL pass wins.
 *
 * Users can supply custom rules via config or rely on the built-in defaults
 * that distinguish "simple" (single-action) from "complex" (multi-step /
 * coordination) messages.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Extensible string literal — users can define arbitrary categories. */
export type IntentCategory = string;

/**
 * A single classification rule. All {@link matchers} must pass (AND logic)
 * for the rule to match. Use separate rules for OR logic.
 */
export interface IntentRule {
  /** Human-readable identifier for debugging / observability. */
  readonly id: string;
  /** The intent category this rule classifies into. */
  readonly category: IntentCategory;
  /** Evaluation order — lower numbers are checked first. */
  readonly priority: number;
  /** Every matcher must pass for this rule to match. */
  readonly matchers: IntentMatcher[];
}

/**
 * A composable matching primitive. Matchers are evaluated against the raw
 * message text.
 *
 * - `regex`    — Tests message against a RegExp built from `pattern` + `flags`.
 * - `keyword`  — Passes if ANY keyword appears in the message (case-insensitive).
 * - `length`   — Passes if message length is within `minLength`..`maxLength`.
 * - `negation` — Inverts the result of `inner`.
 */
export interface IntentMatcher {
  readonly type: "regex" | "keyword" | "length" | "negation";
  /** RegExp source string (for `regex` type). */
  readonly pattern?: string;
  /** RegExp flags, e.g. `"i"` for case-insensitive (for `regex` type). */
  readonly flags?: string;
  /** Keyword list — any match passes (for `keyword` type). */
  readonly keywords?: string[];
  /** Minimum message length in characters (for `length` type). */
  readonly minLength?: number;
  /** Maximum message length in characters (for `length` type). */
  readonly maxLength?: number;
  /** Inner matcher whose result is inverted (for `negation` type). */
  readonly inner?: IntentMatcher;
}

/** The result of classifying a message. */
export interface IntentClassification {
  /** The matched category, or `"default"` if no rule matched. */
  readonly category: IntentCategory;
  /**
   * Confidence level derived from matcher specificity:
   *  - `high`   — matched a specific regex pattern
   *  - `medium` — matched via keyword or composite rule
   *  - `low`    — matched via length-only rule or default fallthrough
   */
  readonly confidence: "high" | "medium" | "low";
  /** The `id` of the matched rule, or `null` for default fallthrough. */
  readonly matchedRule: string | null;
}

// ---------------------------------------------------------------------------
// Matcher evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single matcher against a message.
 *
 * @returns `true` if the matcher condition is satisfied.
 */
export function evaluateMatcher(matcher: IntentMatcher, message: string): boolean {
  switch (matcher.type) {
    case "regex": {
      if (!matcher.pattern) {
        return false;
      }
      try {
        const re = new RegExp(matcher.pattern, matcher.flags ?? "");
        return re.test(message);
      } catch {
        // Invalid regex pattern — treat as non-match rather than crashing.
        return false;
      }
    }

    case "keyword": {
      if (!matcher.keywords || matcher.keywords.length === 0) {
        return false;
      }
      const lower = message.toLowerCase();
      return matcher.keywords.some((kw) => lower.includes(kw.toLowerCase()));
    }

    case "length": {
      const len = message.length;
      if (matcher.minLength !== undefined && len < matcher.minLength) {
        return false;
      }
      if (matcher.maxLength !== undefined && len > matcher.maxLength) {
        return false;
      }
      return true;
    }

    case "negation": {
      if (!matcher.inner) {
        return true;
      }
      return !evaluateMatcher(matcher.inner, message);
    }

    default:
      return false;
  }
}

/**
 * Derive a confidence level from the matchers that contributed to a match.
 *
 * - Any regex matcher → `high`
 * - Any keyword matcher (no regex) → `medium`
 * - Length-only or negation-only → `low`
 */
function deriveConfidence(matchers: IntentMatcher[]): "high" | "medium" | "low" {
  let hasRegex = false;
  let hasKeyword = false;

  for (const m of matchers) {
    if (m.type === "regex") {
      hasRegex = true;
    }
    if (m.type === "keyword") {
      hasKeyword = true;
    }
  }

  if (hasRegex) {
    return "high";
  }
  if (hasKeyword) {
    return "medium";
  }
  return "low";
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a message against an ordered list of intent rules.
 *
 * Rules are sorted by `priority` (ascending) and evaluated sequentially. The
 * first rule whose matchers ALL pass determines the classification. If no rule
 * matches, the result is `{ category: 'default', confidence: 'low' }`.
 *
 * @param message - The raw user message text.
 * @param rules   - Intent rules to evaluate. Defaults to {@link DEFAULT_INTENT_RULES}.
 */
export function classifyIntent(
  message: string,
  rules: readonly IntentRule[] = DEFAULT_INTENT_RULES,
): IntentClassification {
  // Sort by priority (stable — preserves insertion order for equal priorities).
  const sorted = [...rules].toSorted((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (rule.matchers.length === 0) {
      continue;
    }

    const allMatch = rule.matchers.every((m) => evaluateMatcher(m, message));
    if (allMatch) {
      return {
        category: rule.category,
        confidence: deriveConfidence(rule.matchers),
        matchedRule: rule.id,
      };
    }
  }

  return { category: "default", confidence: "low", matchedRule: null };
}

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

/**
 * Built-in complexity detection rules.
 *
 * Ported from the `isSimpleGoal()` heuristics in open-multi-agent, extended
 * with multilingual support and structured as composable matcher rules.
 *
 * The "complex" rules use OR-per-rule design: each regex pattern is a
 * separate rule (all at priority 10) so that ANY pattern matching is enough
 * to classify a message as complex.
 */
export const DEFAULT_INTENT_RULES: IntentRule[] = [
  // -----------------------------------------------------------------------
  // Complex: sequencing patterns
  // -----------------------------------------------------------------------
  {
    id: "complex:first-then",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bfirst\\b.{3,60}\\bthen\\b", flags: "i" }],
  },
  {
    id: "complex:step-n",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bstep\\s*\\d", flags: "i" }],
  },
  {
    id: "complex:phase-n",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bphase\\s*\\d", flags: "i" }],
  },
  {
    id: "complex:stage-n",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bstage\\s*\\d", flags: "i" }],
  },
  {
    id: "complex:numbered-list",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "^\\s*\\d+[.)]", flags: "m" }],
  },

  // -----------------------------------------------------------------------
  // Complex: coordination language
  // -----------------------------------------------------------------------
  {
    id: "complex:collaborate",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bcollaborat", flags: "i" }],
  },
  {
    id: "complex:coordinate",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bcoordinat", flags: "i" }],
  },
  {
    id: "complex:review-each-other",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\breview\\s+each\\s+other", flags: "i" }],
  },
  {
    id: "complex:work-together",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bwork\\s+together\\b", flags: "i" }],
  },

  // -----------------------------------------------------------------------
  // Complex: parallel execution
  // -----------------------------------------------------------------------
  {
    id: "complex:in-parallel",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bin\\s+parallel\\b", flags: "i" }],
  },
  {
    id: "complex:concurrently",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bconcurrently\\b", flags: "i" }],
  },
  {
    id: "complex:same-time",
    category: "complex",
    priority: 10,
    matchers: [{ type: "regex", pattern: "\\bat\\s+the\\s+same\\s+time\\b", flags: "i" }],
  },

  // -----------------------------------------------------------------------
  // Complex: multiple deliverables joined by connectives
  // -----------------------------------------------------------------------
  {
    id: "complex:multi-deliverable",
    category: "complex",
    priority: 10,
    matchers: [
      {
        type: "regex",
        pattern:
          "\\b(?:build|create|implement|design|write|develop)\\b.{5,80}\\b(?:and|then)\\b.{5,80}\\b(?:build|create|implement|design|write|develop|test|review|deploy)\\b",
        flags: "i",
      },
    ],
  },

  // -----------------------------------------------------------------------
  // Complex: Chinese multi-step markers
  // -----------------------------------------------------------------------
  {
    id: "complex:zh-sequence",
    category: "complex",
    priority: 10,
    matchers: [
      {
        type: "keyword",
        keywords: ["第一步", "第二步", "第三步", "首先", "然后", "最后", "分步", "步骤"],
      },
    ],
  },

  // -----------------------------------------------------------------------
  // Complex: very long messages (>500 chars)
  // -----------------------------------------------------------------------
  {
    id: "complex:long-message",
    category: "complex",
    priority: 15,
    matchers: [{ type: "length", minLength: 500 }],
  },

  // -----------------------------------------------------------------------
  // Simple: short messages with no complexity signals
  // -----------------------------------------------------------------------
  {
    id: "simple:short",
    category: "simple",
    priority: 20,
    matchers: [{ type: "length", maxLength: 200 }],
  },
];
