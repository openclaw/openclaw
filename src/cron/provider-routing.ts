import { GOOGLE_GEMINI_DEFAULT_MODEL } from "../commands/google-gemini-model-default.js";
import { OPENAI_CODEX_DEFAULT_MODEL } from "../commands/openai-codex-model-default.js";
import type { CronJob } from "./types.js";

type CronProviderTarget = "claude" | "codex" | "gemini";

type CronProviderRoutingJob = Pick<CronJob, "agentId" | "name" | "description" | "payload"> & {
  pacing?: {
    providerTarget?: CronProviderTarget;
    role?: string;
  };
};

export type CronProviderInferenceConfidence = "medium" | "high";
export type CronProviderRoutingSource = "explicit" | "inferred";

export type CronProviderInference = {
  providerTarget: CronProviderTarget;
  confidence: CronProviderInferenceConfidence;
  reason: string;
};

export type ResolvedCronProviderRouting = CronProviderInference & {
  source: CronProviderRoutingSource;
  modelRef: string;
};

type ScoreCard = Record<CronProviderTarget, number>;

const CLAUDE_PROVIDER_MODEL = "anthropic/claude-sonnet-4-6";

const CODEX_TERMS: Array<[string, number]> = [
  ["implement", 3],
  ["implementation", 3],
  ["feature", 3],
  ["bugfix", 3],
  ["bug fix", 3],
  ["repo", 2],
  ["code", 2],
  ["programming", 2],
  ["test", 2],
  ["coverage", 2],
  ["dependency", 2],
  ["audit", 2],
  ["dead code", 3],
  ["dispatch", 2],
  ["backlog", 2],
  ["sweep", 2],
  ["scan", 2],
];

const CLAUDE_TERMS: Array<[string, number]> = [
  ["refactor", 4],
  ["lint", 4],
  ["cleanup", 3],
  ["clean up", 3],
  ["docs drift", 4],
  ["docs", 2],
  ["review", 2],
  ["canon", 3],
  ["narrative", 2],
  ["creative", 2],
  ["visual", 2],
  ["coaching", 2],
  ["family", 2],
  ["brief", 1],
  ["artifact", 1],
];

const GEMINI_TERMS: Array<[string, number]> = [
  ["deep research", 5],
  ["research brief", 5],
  ["narrative research", 5],
  ["market research", 5],
  ["research", 4],
  ["web_search", 3],
  ["web search", 3],
  ["signal scan", 3],
  ["signals", 2],
  ["market", 2],
  ["competitor", 3],
  ["compare", 2],
  ["comparison", 2],
  ["benchmark", 2],
  ["survey", 2],
  ["investigate", 2],
  ["synthesis", 2],
  ["synthesize", 2],
  ["trend", 2],
  ["monetization", 2],
];

function buildHaystack(job: Pick<CronJob, "agentId" | "name" | "description" | "payload">): string {
  const taskText = job.payload.kind === "agentTurn" ? job.payload.message : job.payload.text;
  return [job.agentId, job.name, job.description, taskText].filter(Boolean).join(" ").toLowerCase();
}

function applyTermScores(haystack: string, terms: Array<[string, number]>): number {
  let score = 0;
  for (const [term, weight] of terms) {
    if (haystack.includes(term)) {
      score += weight;
    }
  }
  return score;
}

function withAgentBias(job: Pick<CronJob, "agentId">, scores: ScoreCard): ScoreCard {
  const agentId = (job.agentId || "").trim().toLowerCase();
  if (agentId === "cody" || agentId === "archie") {
    scores.codex += 1;
  }
  if (
    ["leo", "storie", "artie", "exdi", "grove", "liev", "nesta", "mako", "clawdy"].includes(agentId)
  ) {
    scores.claude += 1;
  }
  return scores;
}

export function inferCronProviderTarget(
  job: Pick<CronJob, "agentId" | "name" | "description" | "payload">,
): CronProviderInference | null {
  const haystack = buildHaystack(job);
  if (!haystack.trim()) {
    return null;
  }

  const scores = withAgentBias(job, {
    codex: applyTermScores(haystack, CODEX_TERMS),
    claude: applyTermScores(haystack, CLAUDE_TERMS),
    gemini: applyTermScores(haystack, GEMINI_TERMS),
  });

  const ranked = (Object.entries(scores) as Array<[CronProviderTarget, number]>).toSorted(
    (a, b) => b[1] - a[1],
  );
  const [winner, winnerScore] = ranked[0] ?? [];
  const runnerUpScore = ranked[1]?.[1] ?? 0;
  if (!winner || winnerScore < 3) {
    return null;
  }
  if (winnerScore - runnerUpScore < 2) {
    return null;
  }

  const confidence: CronProviderInferenceConfidence = winnerScore >= 6 ? "high" : "medium";
  if (winner === "gemini") {
    return { providerTarget: winner, confidence, reason: "research-heavy cron content" };
  }
  if (winner === "codex") {
    return { providerTarget: winner, confidence, reason: "implementation-heavy cron content" };
  }
  return { providerTarget: winner, confidence, reason: "review/refactor-heavy cron content" };
}

function matchesProviderFamily(params: {
  providerTarget: CronProviderTarget;
  provider: string;
  model: string;
}): boolean {
  const provider = params.provider.trim().toLowerCase();
  const model = params.model.trim().toLowerCase();
  if (params.providerTarget === "claude") {
    return (
      provider === "anthropic" ||
      provider === "claude" ||
      provider === "claude-cli" ||
      model.includes("claude")
    );
  }
  if (params.providerTarget === "codex") {
    return provider === "openai-codex" || provider === "codex-cli" || model.includes("codex");
  }
  return (
    provider === "google" ||
    provider === "google-gemini-cli" ||
    provider === "gemini" ||
    model.includes("gemini")
  );
}

function matchesProviderTargetRef(providerTarget: CronProviderTarget, rawRef: string): boolean {
  const normalized = rawRef.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (providerTarget === "claude") {
    return normalized.includes("claude");
  }
  if (providerTarget === "codex") {
    return (
      normalized.startsWith("codex/") ||
      normalized.startsWith("codex-cli/") ||
      normalized.includes("codex")
    );
  }
  return normalized.includes("gemini");
}

function rankConfiguredProviderTargetModelRef(
  providerTarget: CronProviderTarget,
  rawRef: string,
): number {
  const normalized = rawRef.trim().toLowerCase();
  if (providerTarget === "claude") {
    if (normalized.startsWith("anthropic/")) {
      return 0;
    }
    if (normalized.startsWith("claude-cli/")) {
      return 1;
    }
    if (normalized.includes("claude")) {
      return 2;
    }
    return 99;
  }
  if (providerTarget === "codex") {
    if (normalized.startsWith("codex/")) {
      return 0;
    }
    if (normalized.startsWith("codex-cli/")) {
      return 1;
    }
    if (normalized.includes("codex")) {
      return 2;
    }
    return 99;
  }
  if (normalized.startsWith("google/")) {
    if (normalized.includes("pro")) {
      return 0;
    }
    if (normalized.includes("flash")) {
      return 1;
    }
    return 2;
  }
  if (normalized.startsWith("blockrun/google/")) {
    if (normalized.includes("pro")) {
      return 3;
    }
    if (normalized.includes("flash")) {
      return 4;
    }
    return 5;
  }
  if (normalized.includes("gemini")) {
    return 6;
  }
  return 99;
}

function findConfiguredProviderTargetModelRef(params: {
  providerTarget: CronProviderTarget;
  configuredModelRefs?: string[];
}): string | null {
  const matches = (params.configuredModelRefs ?? []).filter((rawRef) =>
    matchesProviderTargetRef(params.providerTarget, rawRef),
  );
  if (matches.length === 0) {
    return null;
  }
  return (
    matches.toSorted((a, b) => {
      const rankDiff =
        rankConfiguredProviderTargetModelRef(params.providerTarget, a) -
        rankConfiguredProviderTargetModelRef(params.providerTarget, b);
      return rankDiff !== 0 ? rankDiff : a.localeCompare(b);
    })[0] ?? null
  );
}

export function resolveCronProviderTargetModelRef(params: {
  providerTarget: CronProviderTarget;
  provider: string;
  model: string;
  configuredModelRefs?: string[];
}): string {
  if (matchesProviderFamily(params)) {
    return `${params.provider}/${params.model}`;
  }
  const configuredMatch = findConfiguredProviderTargetModelRef({
    providerTarget: params.providerTarget,
    configuredModelRefs: params.configuredModelRefs,
  });
  if (configuredMatch) {
    return configuredMatch;
  }
  if (params.providerTarget === "codex") {
    return OPENAI_CODEX_DEFAULT_MODEL;
  }
  if (params.providerTarget === "gemini") {
    return GOOGLE_GEMINI_DEFAULT_MODEL;
  }
  return CLAUDE_PROVIDER_MODEL;
}

export function resolveCronProviderRouting(params: {
  job: CronProviderRoutingJob;
  provider: string;
  model: string;
  configuredModelRefs?: string[];
}): ResolvedCronProviderRouting | null {
  const explicit = params.job.pacing?.providerTarget;
  if (explicit === "claude" || explicit === "codex" || explicit === "gemini") {
    return {
      providerTarget: explicit,
      source: "explicit",
      confidence: "high",
      reason: "explicit provider ownership tag",
      modelRef: resolveCronProviderTargetModelRef({
        providerTarget: explicit,
        provider: params.provider,
        model: params.model,
        configuredModelRefs: params.configuredModelRefs,
      }),
    };
  }

  const inferred = inferCronProviderTarget(params.job);
  if (!inferred) {
    return null;
  }
  return {
    ...inferred,
    source: "inferred",
    modelRef: resolveCronProviderTargetModelRef({
      providerTarget: inferred.providerTarget,
      provider: params.provider,
      model: params.model,
      configuredModelRefs: params.configuredModelRefs,
    }),
  };
}
