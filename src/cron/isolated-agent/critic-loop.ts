import type {
  CronCriticEvaluation,
  CronCriticMode,
  CronCriticRedTeamCategory,
  CronCriticRedTeamCheck,
  CronCriticScore,
  CronCriticSeverity,
  CronCriticSeverityThreshold,
} from "../types.js";

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MODE: CronCriticMode = "score";
const DEFAULT_RED_TEAM_SEVERITY_THRESHOLD: CronCriticSeverityThreshold = "high";
const MAX_SPEC_TOKENS = 40;

const SEVERITY_RANK: Record<CronCriticSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

type RedTeamSignal = {
  label: string;
  pattern: RegExp;
};

type RedTeamVector = {
  category: CronCriticRedTeamCategory;
  attackPrompt: string;
  recommendation: string;
  specSignals: ReadonlyArray<RedTeamSignal>;
  guardSignals: ReadonlyArray<RedTeamSignal>;
  dangerSignals: ReadonlyArray<RedTeamSignal>;
  missingGuardSeverity: CronCriticSeverity;
  dangerSeverity: CronCriticSeverity;
};

const RED_TEAM_VECTORS: ReadonlyArray<RedTeamVector> = [
  {
    category: "leakage",
    attackPrompt:
      "Adversarial pass (leakage): Assume the plan leaks future information or labels. What evidence proves point-in-time integrity?",
    recommendation:
      "Add explicit leakage defenses (time-split validation, point-in-time joins, and holdout checks) before approval.",
    specSignals: [
      { label: "leakage", pattern: /\bleak(?:age|ed)?\b/i },
      { label: "lookahead", pattern: /\blook[-\s]?ahead\b/i },
      { label: "future-data", pattern: /\bfuture\b/i },
      { label: "validation", pattern: /\bvalidation\b/i },
    ],
    guardSignals: [
      { label: "point-in-time", pattern: /\bpoint[-\s]?in[-\s]?time\b/i },
      { label: "time-split", pattern: /\btime[-\s]?split\b/i },
      { label: "holdout", pattern: /\bholdout\b/i },
      { label: "walk-forward", pattern: /\bwalk[-\s]?forward\b/i },
      { label: "no-lookahead", pattern: /\bno\s+look[-\s]?ahead\b/i },
    ],
    dangerSignals: [
      { label: "ignore-leakage", pattern: /\bignore\s+leak(?:age)?\b/i },
      { label: "future-data-used", pattern: /\buse\s+future\s+data\b/i },
      { label: "after-the-fact", pattern: /\bafter\s+the\s+fact\b/i },
    ],
    missingGuardSeverity: "high",
    dangerSeverity: "critical",
  },
  {
    category: "slippage_blindness",
    attackPrompt:
      "Adversarial pass (slippage blindness): Assume execution costs invalidate the edge. Where are slippage/fees/funding stress checks?",
    recommendation:
      "Account for execution reality (fees, spread, slippage, and funding) with explicit stress cases.",
    specSignals: [
      { label: "slippage", pattern: /\bslippage\b/i },
      { label: "fees", pattern: /\bfees?\b/i },
      { label: "funding", pattern: /\bfunding\b/i },
      { label: "spread", pattern: /\bspread\b/i },
      { label: "execution", pattern: /\bexecution\b/i },
    ],
    guardSignals: [
      { label: "slippage-modeled", pattern: /\bslippage\b/i },
      { label: "fees-modeled", pattern: /\bfees?\b/i },
      { label: "funding-modeled", pattern: /\bfunding\b/i },
      { label: "spread-modeled", pattern: /\bspread\b/i },
      { label: "impact-modeled", pattern: /\b(?:market\s+)?impact\b/i },
    ],
    dangerSignals: [
      { label: "zero-slippage", pattern: /\bzero\s+slippage\b/i },
      { label: "ignore-fees", pattern: /\bignore\s+fees?\b/i },
      { label: "frictionless", pattern: /\bfrictionless\b/i },
      { label: "no-costs", pattern: /\bwithout\s+(?:any\s+)?(?:costs?|fees?)\b/i },
    ],
    missingGuardSeverity: "high",
    dangerSeverity: "high",
  },
  {
    category: "unrealistic_assumptions",
    attackPrompt:
      "Adversarial pass (unrealistic assumptions): Assume optimistic claims fail in production. Which constraints and failure modes are missing?",
    recommendation:
      "Convert optimistic claims into testable assumptions with explicit constraints, risks, and rollback criteria.",
    specSignals: [
      { label: "assumptions", pattern: /\bassumptions?\b/i },
      { label: "constraints", pattern: /\bconstraints?\b/i },
      { label: "risks", pattern: /\brisks?\b/i },
      { label: "plan", pattern: /\bplan\b/i },
      { label: "strategy", pattern: /\bstrategy\b/i },
    ],
    guardSignals: [
      { label: "assumption-log", pattern: /\bassumptions?\b/i },
      { label: "constraints-listed", pattern: /\bconstraints?\b/i },
      { label: "risk-register", pattern: /\brisks?\b/i },
      { label: "fallback", pattern: /\bfallback\b/i },
      { label: "verification", pattern: /\bverify|validation|experiment\b/i },
    ],
    dangerSignals: [
      { label: "guaranteed", pattern: /\bguaranteed\b/i },
      { label: "always-works", pattern: /\balways\s+works\b/i },
      { label: "no-risk", pattern: /\bno\s+risk\b/i },
      { label: "never-fails", pattern: /\bnever\s+fails\b/i },
    ],
    missingGuardSeverity: "medium",
    dangerSeverity: "high",
  },
  {
    category: "hidden_coupling",
    attackPrompt:
      "Adversarial pass (hidden coupling): Assume an implicit dependency breaks the rollout. Where are boundaries/contracts and isolation plans?",
    recommendation:
      "Surface dependencies explicitly and define ownership, interfaces, and rollback boundaries to avoid hidden coupling.",
    specSignals: [
      { label: "dependency", pattern: /\bdependenc(?:y|ies)\b/i },
      { label: "integration", pattern: /\bintegration\b/i },
      { label: "service", pattern: /\bservice\b/i },
      { label: "pipeline", pattern: /\bpipeline\b/i },
      { label: "coupling", pattern: /\bcoupl(?:e|ing)\b/i },
    ],
    guardSignals: [
      { label: "interface-contract", pattern: /\binterface|contract\b/i },
      { label: "ownership", pattern: /\bowner(?:ship)?\b/i },
      { label: "feature-flag", pattern: /\bfeature\s+flag\b/i },
      { label: "rollback-boundary", pattern: /\brollback\b/i },
      { label: "isolation", pattern: /\bisolat(?:e|ion)\b/i },
    ],
    dangerSignals: [
      { label: "tight-coupling", pattern: /\btight(?:ly)?\s+coupl(?:ed|ing)\b/i },
      { label: "hardcoded-dependency", pattern: /\bhardcoded\b/i },
      { label: "single-point-failure", pattern: /\bsingle\s+point\s+of\s+failure\b/i },
      { label: "implicit-dependency", pattern: /\bimplicit\s+dependenc(?:y|ies)\b/i },
    ],
    missingGuardSeverity: "medium",
    dangerSeverity: "high",
  },
];

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

function normalizeMode(mode?: CronCriticMode): CronCriticMode {
  return mode === "redTeam" ? "redTeam" : DEFAULT_MODE;
}

function normalizeRedTeamSeverityThreshold(
  threshold?: CronCriticSeverityThreshold,
): CronCriticSeverityThreshold {
  if (
    threshold === "low" ||
    threshold === "medium" ||
    threshold === "high" ||
    threshold === "critical"
  ) {
    return threshold;
  }
  return DEFAULT_RED_TEAM_SEVERITY_THRESHOLD;
}

function isSeverityAtLeast(
  severity: CronCriticSeverity,
  threshold: CronCriticSeverityThreshold,
): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

function resolveMaxSeverity(values: ReadonlyArray<CronCriticSeverity>): CronCriticSeverity {
  let max: CronCriticSeverity = "none";
  for (const value of values) {
    if (SEVERITY_RANK[value] > SEVERITY_RANK[max]) {
      max = value;
    }
  }
  return max;
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

function getMatchedSignalLabels(text: string, signals: ReadonlyArray<RedTeamSignal>) {
  const labels: string[] = [];
  for (const signal of signals) {
    if (signal.pattern.test(text)) {
      labels.push(signal.label);
    }
  }
  return labels;
}

function buildRedTeamCheck(params: {
  vector: RedTeamVector;
  spec: string;
  output: string;
}): CronCriticRedTeamCheck {
  const { vector, spec, output } = params;
  const specSignals = getMatchedSignalLabels(spec, vector.specSignals);
  const dangerSignals = getMatchedSignalLabels(output, vector.dangerSignals);
  const guardSignals = getMatchedSignalLabels(output, vector.guardSignals);

  const hasSpecSignal = specSignals.length > 0;
  const hasDangerSignal = dangerSignals.length > 0;
  const hasGuardSignal = guardSignals.length > 0;

  let severity: CronCriticSeverity = "none";
  let rationale = "No immediate adversarial weakness detected for this vector.";

  if (hasDangerSignal) {
    severity = vector.dangerSeverity;
    rationale = `Risky assumptions detected: ${dangerSignals.join(", ")}.`;
  } else if (hasSpecSignal && !hasGuardSignal) {
    severity = vector.missingGuardSeverity;
    rationale = `Spec references this risk vector (${specSignals.join(", ")}) but output has no explicit mitigation.`;
  } else if (!hasSpecSignal && !hasGuardSignal) {
    severity = "low";
    rationale = "No explicit mitigation evidence found for this adversarial vector.";
  } else if (hasGuardSignal) {
    rationale = `Mitigation evidence present: ${guardSignals.join(", ")}.`;
  }

  const evidence = [
    ...specSignals.map((label) => `spec:${label}`),
    ...dangerSignals.map((label) => `danger:${label}`),
    ...guardSignals.map((label) => `guard:${label}`),
  ];

  return {
    category: vector.category,
    severity,
    attackPrompt: vector.attackPrompt,
    rationale,
    evidence,
    recommendation: vector.recommendation,
  };
}

function runRedTeamPass(params: {
  spec: string;
  output: string;
  threshold?: CronCriticSeverityThreshold;
}) {
  const threshold = normalizeRedTeamSeverityThreshold(params.threshold);
  const checks = RED_TEAM_VECTORS.map((vector) =>
    buildRedTeamCheck({ vector, spec: params.spec, output: params.output }),
  );
  const findings = checks.filter((check) => check.severity !== "none");
  const maxSeverity = resolveMaxSeverity(checks.map((check) => check.severity));
  return {
    threshold,
    maxSeverity,
    failed: isSeverityAtLeast(maxSeverity, threshold),
    checks,
    findings,
  };
}

export function evaluateExecutorOutputCritic(params: {
  enabled: boolean;
  killSwitch?: boolean;
  spec?: string;
  output?: string;
  threshold?: number;
  mode?: CronCriticMode;
  redTeamSeverityThreshold?: CronCriticSeverityThreshold;
}): CronCriticEvaluation | null {
  if (!params.enabled || params.killSwitch) {
    return null;
  }
  const spec = params.spec?.trim();
  if (!spec) {
    return null;
  }

  const mode = normalizeMode(params.mode);
  const output = params.output?.trim() ?? "";
  const threshold = clamp01(params.threshold ?? DEFAULT_THRESHOLD);

  const scores = [
    scoreCoverage(spec, output),
    scoreCompleteness(output),
    scoreActionability(output),
  ];
  const score = round(scores.reduce((acc, item) => acc + item.weighted, 0));
  const scorePassed = score >= threshold;

  const redTeam =
    mode === "redTeam"
      ? runRedTeamPass({
          spec,
          output,
          threshold: params.redTeamSeverityThreshold,
        })
      : undefined;

  const passed = scorePassed && !redTeam?.failed;

  return {
    version: "v1",
    mode,
    spec,
    threshold: round(threshold),
    score,
    passed,
    outcome: passed ? "completed" : "needs_replan",
    scores,
    redTeam,
  };
}
