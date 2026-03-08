export type StressRegimeLabel = "pre" | "post";

export type StressRegimeSplitMode = "half" | "index";

export type StressScenario = {
  /** Scenario identifier used for debugging/reporting. */
  name: string;
  /** Multiplicative shock applied to the base score (default: 1). */
  multiplier?: number;
  /** Additive shock applied after multiplier (default: 0). */
  offset?: number;
};

export type StressRegimeSplitConfig = {
  /**
   * - half: first half of results are "pre", second half are "post"
   * - index: split explicitly at splitIndex
   */
  mode: StressRegimeSplitMode;
  /** Used only when mode = "index". */
  splitIndex?: number;
};

export type StressScoringConfig = {
  /** Enable/disable regime/stress penalties. Default: false (opt-in). */
  enabled: boolean;
  /**
   * Weight for cross-regime instability.
   * penalty = instabilityWeight * |mean(pre) - mean(post)|
   */
  instabilityWeight: number;
  /**
   * Weight for stress dispersion.
   * penalty = stressWeight * (max(stressScores) - min(stressScores))
   */
  stressWeight: number;
  regimeSplit: StressRegimeSplitConfig;
  scenarios: StressScenario[];
};

export type StressRegimeSplitResolver<T> = (params: {
  entry: T;
  index: number;
  entries: T[];
  defaultRegime: StressRegimeLabel;
  splitIndex: number;
}) => StressRegimeLabel;

export const DEFAULT_STRESS_SCORING_CONFIG: StressScoringConfig = {
  enabled: false,
  instabilityWeight: 0.2,
  stressWeight: 0.15,
  regimeSplit: {
    mode: "half",
  },
  scenarios: [
    { name: "mild-drawdown", multiplier: 0.9 },
    { name: "hard-drawdown", multiplier: 0.75 },
  ],
};

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sanitizeNonNegative(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, value);
}

function normalizeSplitIndex(total: number, split: StressRegimeSplitConfig): number {
  if (total <= 1) {
    return 1;
  }

  if (split.mode === "index") {
    const requested = Number.isFinite(split.splitIndex) ? Math.floor(split.splitIndex ?? 0) : 0;
    return Math.max(1, Math.min(total - 1, requested));
  }

  return Math.max(1, Math.min(total - 1, Math.ceil(total / 2)));
}

/**
 * Assigns each item to either pre/post regime.
 *
 * This is the pre/post regime split hook for distribution-shift stress scoring:
 * callers can override `defaultRegime` via `resolver`.
 */
export function resolveRegimeSplits<T>(params: {
  entries: T[];
  regimeSplit?: Partial<StressRegimeSplitConfig>;
  resolver?: StressRegimeSplitResolver<T>;
}): StressRegimeLabel[] {
  const split: StressRegimeSplitConfig = {
    ...DEFAULT_STRESS_SCORING_CONFIG.regimeSplit,
    ...params.regimeSplit,
  };
  const total = params.entries.length;
  const splitIndex = normalizeSplitIndex(total, split);

  return params.entries.map((entry, index) => {
    const defaultRegime: StressRegimeLabel = index < splitIndex ? "pre" : "post";
    if (!params.resolver) {
      return defaultRegime;
    }
    const override = params.resolver({
      entry,
      index,
      entries: params.entries,
      defaultRegime,
      splitIndex,
    });
    return override === "post" ? "post" : "pre";
  });
}

export function calculateInstabilityPenalty(params: {
  preScores: number[];
  postScores: number[];
  instabilityWeight: number;
}): number {
  const weight = sanitizeNonNegative(params.instabilityWeight);
  if (weight <= 0 || params.preScores.length === 0 || params.postScores.length === 0) {
    return 0;
  }

  const shiftMagnitude = Math.abs(average(params.preScores) - average(params.postScores));
  return weight * shiftMagnitude;
}

export function runStressScenarios(baseScore: number, scenarios: StressScenario[]): number[] {
  return scenarios.map((scenario) => {
    const multiplier = Number.isFinite(scenario.multiplier) ? (scenario.multiplier ?? 1) : 1;
    const offset = Number.isFinite(scenario.offset) ? (scenario.offset ?? 0) : 0;
    return baseScore * multiplier + offset;
  });
}

export function calculateStressPenalty(params: {
  baseScore: number;
  scenarios: StressScenario[];
  stressWeight: number;
}): number {
  const weight = sanitizeNonNegative(params.stressWeight);
  if (weight <= 0 || params.scenarios.length === 0) {
    return 0;
  }

  const stressedScores = runStressScenarios(params.baseScore, params.scenarios);
  const allScores = [params.baseScore, ...stressedScores];
  const maxScore = Math.max(...allScores);
  const minScore = Math.min(...allScores);
  const dispersion = Math.max(0, maxScore - minScore);
  return weight * dispersion;
}

/**
 * Final score formula (MVP):
 *
 *   finalScore = max(0, baseScore - instabilityPenalty - stressPenalty)
 */
export function composeStressAdjustedScore(params: {
  baseScore: number;
  instabilityPenalty: number;
  stressPenalty: number;
}): number {
  const baseScore = Number.isFinite(params.baseScore) ? params.baseScore : 0;
  const totalPenalty =
    sanitizeNonNegative(params.instabilityPenalty) + sanitizeNonNegative(params.stressPenalty);
  return Math.max(0, baseScore - totalPenalty);
}

export function applyStressScoringToResults<T extends { score: number }>(params: {
  results: T[];
  stressScoring?: Partial<StressScoringConfig>;
  regimeSplitResolver?: StressRegimeSplitResolver<T>;
}): T[] {
  const cfg: StressScoringConfig = {
    ...DEFAULT_STRESS_SCORING_CONFIG,
    ...params.stressScoring,
    regimeSplit: {
      ...DEFAULT_STRESS_SCORING_CONFIG.regimeSplit,
      ...params.stressScoring?.regimeSplit,
    },
    scenarios: params.stressScoring?.scenarios ?? DEFAULT_STRESS_SCORING_CONFIG.scenarios,
  };

  if (!cfg.enabled || params.results.length === 0) {
    return [...params.results];
  }

  const regimes = resolveRegimeSplits({
    entries: params.results,
    regimeSplit: cfg.regimeSplit,
    resolver: params.regimeSplitResolver,
  });

  const preScores: number[] = [];
  const postScores: number[] = [];

  for (const [index, result] of params.results.entries()) {
    const score = Number.isFinite(result.score) ? result.score : 0;
    if (regimes[index] === "post") {
      postScores.push(score);
    } else {
      preScores.push(score);
    }
  }

  const instabilityPenalty = calculateInstabilityPenalty({
    preScores,
    postScores,
    instabilityWeight: cfg.instabilityWeight,
  });

  return params.results.map((result) => {
    const baseScore = Number.isFinite(result.score) ? result.score : 0;
    const stressPenalty = calculateStressPenalty({
      baseScore,
      scenarios: cfg.scenarios,
      stressWeight: cfg.stressWeight,
    });

    return {
      ...result,
      score: composeStressAdjustedScore({
        baseScore,
        instabilityPenalty,
        stressPenalty,
      }),
    };
  });
}
