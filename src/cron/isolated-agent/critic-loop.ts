import type { CronCriticEvaluation, CronCriticScore } from "../types.js";

const DEFAULT_THRESHOLD = 0.7;
const MAX_SPEC_TOKENS = 40;

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function tokenize(value: string) {
  return (value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).slice(0, MAX_SPEC_TOKENS);
}

function toUniqueTokens(value: string) {
  return [...new Set(tokenize(value))];
}

function scoreCoverage(spec: string, output: string): CronCriticScore {
  const specTokens = toUniqueTokens(spec);
  if (specTokens.length === 0) {
    return {
      key: "spec_coverage",
      score: 1,
      weight: 0.55,
      weighted: 0.55,
      note: "Spec has no evaluable tokens; treated as fully covered",
    };
  }
  const outputTokens = new Set(tokenize(output));
  const matched = specTokens.filter((token) => outputTokens.has(token)).length;
  const score = clamp01(matched / specTokens.length);
  const weight = 0.55;
  return {
    key: "spec_coverage",
    score: round(score),
    weight,
    weighted: round(score * weight),
    note: `Matched ${matched}/${specTokens.length} spec tokens`,
  };
}

function scoreCompleteness(output: string): CronCriticScore {
  const length = output.trim().length;
  const score =
    length >= 600 ? 1 : length >= 300 ? 0.85 : length >= 140 ? 0.65 : length >= 60 ? 0.45 : 0.25;
  const weight = 0.25;
  return {
    key: "completeness",
    score: round(score),
    weight,
    weighted: round(score * weight),
    note: `Output length ${length} chars`,
  };
}

function scoreActionability(output: string): CronCriticScore {
  const hasList = /(^|\n)\s*(?:[-*]|\d+[.)])\s+\S/m.test(output);
  const hasActionWords = /\b(next|step|todo|action|implement|fix|replan|verify)\b/i.test(output);
  const score = hasList && hasActionWords ? 1 : hasList || hasActionWords ? 0.6 : 0.3;
  const weight = 0.2;
  return {
    key: "actionability",
    score: round(score),
    weight,
    weighted: round(score * weight),
    note: `list=${hasList ? "yes" : "no"}, action_words=${hasActionWords ? "yes" : "no"}`,
  };
}

export function evaluateExecutorOutputCritic(params: {
  enabled: boolean;
  killSwitch?: boolean;
  spec?: string;
  output?: string;
  threshold?: number;
}): CronCriticEvaluation | null {
  if (!params.enabled || params.killSwitch) {
    return null;
  }
  const spec = params.spec?.trim();
  if (!spec) {
    return null;
  }

  const output = params.output?.trim() ?? "";
  const threshold = clamp01(params.threshold ?? DEFAULT_THRESHOLD);

  const scores = [
    scoreCoverage(spec, output),
    scoreCompleteness(output),
    scoreActionability(output),
  ];
  const score = round(scores.reduce((acc, item) => acc + item.weighted, 0));
  const passed = score >= threshold;

  return {
    version: "v1",
    spec,
    threshold: round(threshold),
    score,
    passed,
    outcome: passed ? "completed" : "needs_replan",
    scores,
  };
}
