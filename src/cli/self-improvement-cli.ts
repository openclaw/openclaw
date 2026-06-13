import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { selfImprovementIntelligenceCategories } from "../self-improvement/intelligence.js";
import {
  DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL,
  DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL,
  DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL,
  DEFAULT_SELF_IMPROVEMENT_TRIAGE_MODEL,
  OPTIONAL_SELF_IMPROVEMENT_EXTERNAL_KIMI_MODEL,
} from "../self-improvement/model-policy.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions, callGatewayFromCli, type GatewayRpcOpts } from "./gateway-rpc.js";

type JsonOpt = { json?: boolean };
type SelfImprovementOpts = GatewayRpcOpts & JsonOpt;
type SelfImprovementListOpts = SelfImprovementOpts & {
  status?: string;
  severity?: string;
  route?: string;
  category?: string;
  limit?: string;
};
type SelfImprovementSummaryOpts = SelfImprovementOpts & {
  status?: string;
  route?: string;
  limit?: string;
};
type SelfImprovementTriageOpts = SelfImprovementSummaryOpts;
type SelfImprovementOpportunitiesOpts = SelfImprovementOpts & {
  status?: string;
  route?: string;
  category?: string;
  limit?: string;
};
type SelfImprovementScorecardOpts = SelfImprovementOpts & {
  days?: string;
  limit?: string;
};
type SelfImprovementHealthOpts = SelfImprovementOpts & {
  days?: string;
  limit?: string;
  failOnDegraded?: boolean;
  failOnBlocked?: boolean;
};
type SelfImprovementProductionCheckOpts = SelfImprovementHealthOpts & {
  requireModelReady?: boolean;
  requireEvalsReady?: boolean;
};
type SelfImprovementMaintenanceOpts = SelfImprovementOpts & {
  apply?: boolean;
  dryRun?: boolean;
};
type SelfImprovementAuditEventsListOpts = SelfImprovementOpts & {
  kind?: string;
  limit?: string;
};
type SelfImprovementAnalyzeOpts = SelfImprovementOpts & {
  limit?: string;
  llm?: boolean;
  approveLlmReview?: boolean;
  model?: string;
  reviewModel?: string;
  fallbackModel?: string;
  strategicModel?: string;
  localFirst?: boolean;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  reviewerAgent?: string;
};
type SelfImprovementPreflightOpts = SelfImprovementOpts & {
  approveLlmReview?: boolean;
  model?: string;
  reviewModel?: string;
  fallbackModel?: string;
  strategicModel?: string;
  strategic?: boolean;
  hosted?: boolean;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  reviewerAgent?: string;
};
type SelfImprovementEvalRunOpts = SelfImprovementOpts & {
  fixtureSet?: string;
  limit?: string;
  approveLlmReview?: boolean;
  reviewModel?: string;
  fallbackModel?: string;
  strategicModel?: string;
  localFirst?: boolean;
  allowStrategicLocal?: boolean;
  allowHostedEscalation?: boolean;
  reviewerAgent?: string;
  failOnThreshold?: boolean;
};
type SelfImprovementUpdateOpts = SelfImprovementOpts & {
  status?: string;
  note?: string;
  assign?: string;
  claimedBy?: string;
  proof?: string;
  dismissalReason?: string;
};
type SelfImprovementAssignOpts = SelfImprovementOpts & {
  agent?: string;
  claimedBy?: string;
  note?: string;
};
type SelfImprovementProveOpts = SelfImprovementOpts & {
  proof?: string;
  resolve?: boolean;
  note?: string;
};
type SelfImprovementProposalListOpts = SelfImprovementOpts & {
  status?: string;
  kind?: string;
  limit?: string;
};
type SelfImprovementProposalUpdateOpts = SelfImprovementOpts & {
  status?: string;
  note?: string;
  proof?: string;
  dismissalReason?: string;
};
type SelfImprovementCuratorListOpts = SelfImprovementOpts & {
  status?: string;
  limit?: string;
};
type SelfImprovementCuratorAcceptOpts = SelfImprovementOpts & {
  proof?: string;
  workshopProposalId?: string;
  note?: string;
};
type SelfImprovementCuratorRejectOpts = SelfImprovementOpts & {
  reason?: string;
  note?: string;
};
type SelfImprovementCuratorWorkshopLinkOpts = SelfImprovementOpts & {
  proof?: string;
  workshopProposalId?: string;
  workshopStatus?: string;
  note?: string;
};
type SelfImprovementCuratorPromoteOpts = SelfImprovementOpts & {
  proof?: string;
  workshopProposalId?: string;
  workshopStatus?: string;
  note?: string;
};

const SELF_IMPROVEMENT_ANALYSIS_RPC_TIMEOUT_MS = 600_000;
const SELF_IMPROVEMENT_EVAL_RPC_TIMEOUT_MS = 900_000;

function buildSelfImprovementModelTemplate() {
  return {
    primary: {
      providerRef: DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL,
      backend: "Ollama",
      quantization: "Q8_0",
      parameters: "27B",
      contextWindow: 65_536,
      maxOutputTokens: 8_192,
      temperature: 0.2,
      topP: 0.95,
      timeoutMs: 180_000,
    },
    fallback: {
      providerRef: DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL,
      backend: "Ollama",
      quantization: "Q6",
      parameters: "30B",
      contextWindow: 262_144,
      temperature: 0.2,
      topP: 0.95,
      timeoutMs: 180_000,
    },
    triage: {
      providerRef: DEFAULT_SELF_IMPROVEMENT_TRIAGE_MODEL,
      backend: "Ollama",
      quantization: "Q4_K_M",
      parameters: "9B",
      contextWindow: 32_768,
      temperature: 0.1,
      topP: 0.95,
      timeoutMs: 60_000,
    },
    strategic: {
      providerRef: DEFAULT_SELF_IMPROVEMENT_STRATEGIC_MODEL,
      backend: "Ollama",
      quantization: "Ollama local",
      parameters: "235B",
      contextWindow: 262_144,
      gatedBy: "--allow-strategic-local",
    },
    optionalExternalGpu: {
      providerRef: OPTIONAL_SELF_IMPROVEMENT_EXTERNAL_KIMI_MODEL,
      status: "disabled by default",
      reason:
        "Kimi requires an external GPU serving host and is not part of production local-first readiness.",
    },
    configPatch: null,
    verification: [
      "openclaw models list --local --json",
      `openclaw infer model run --model ${DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL} --prompt '{"ping":true}' --local --json`,
      `openclaw self-improvement preflight --review-model ${DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL} --fallback-model ${DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL}`,
      `openclaw self-improvement analyze --local-first --review-model ${DEFAULT_SELF_IMPROVEMENT_PRIMARY_REVIEW_MODEL} --fallback-model ${DEFAULT_SELF_IMPROVEMENT_FALLBACK_MODEL} --limit 1 --json`,
    ],
    safety: [
      "This template is read-only and does not mutate runtime config.",
      "The production Governor policy uses already-installed local Ollama models.",
      "Kimi is optional external-GPU guidance only, not a production-grade requirement.",
      "Hosted escalation still requires explicit allow, approval, and OPENCLAW_SELF_IMPROVEMENT_LLM=1.",
    ],
  };
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("--limit must be an integer from 1 to 500");
  }
  return parsed;
}

function parseBoundedInteger(
  value: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function formatConfidencePercent(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return `confidence ${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function formatCliValue(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return Number.isFinite(value) ? `${value}` : fallback;
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `${value}`;
    case "symbol":
      return value.description ?? fallback;
    case "function":
      return `[function ${value.name || "anonymous"}]`;
    case "object":
      break;
    case "undefined":
      return fallback;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json : fallback;
  } catch {
    return fallback;
  }
}

function printRecommendations(result: unknown) {
  const recommendations =
    (result as { recommendations?: Array<Record<string, unknown>> })?.recommendations ?? [];
  if (recommendations.length === 0) {
    defaultRuntime.log("No self-improvement recommendations.");
    return;
  }
  for (const recommendation of recommendations) {
    const id = formatCliValue(recommendation.id ?? "");
    const title = formatCliValue(recommendation.title ?? "");
    const severity = formatCliValue(recommendation.severity ?? "");
    const status = formatCliValue(recommendation.status ?? "");
    const route = (recommendation.route as { targetAgentLabel?: unknown } | undefined)
      ?.targetAgentLabel;
    const confidence = formatConfidencePercent(recommendation.confidence);
    defaultRuntime.log(
      `${id}  ${severity}/${status}${confidence ? `  ${confidence}` : ""}  ${formatCliValue(
        route ?? "",
      )}  ${title}`,
    );
  }
}

function printOpportunities(result: unknown) {
  const recommendations =
    (result as { recommendations?: Array<Record<string, unknown>> })?.recommendations ?? [];
  const total = (result as { total?: unknown })?.total;
  defaultRuntime.log(
    `Improvement opportunities ${formatCliValue(total ?? recommendations.length)}`,
  );
  if (recommendations.length === 0) {
    defaultRuntime.log("No continuous-improvement opportunities.");
    return;
  }
  for (const recommendation of recommendations) {
    const route = (recommendation.route as { targetAgentLabel?: unknown } | undefined)
      ?.targetAgentLabel;
    const confidence = formatConfidencePercent(recommendation.confidence);
    defaultRuntime.log(
      `${formatCliValue(recommendation.id ?? "")}  ${formatCliValue(recommendation.category ?? "")}  ${formatCliValue(
        recommendation.priority ?? recommendation.severity ?? "",
      )}/${formatCliValue(recommendation.status ?? "")}${confidence ? `  ${confidence}` : ""}  ${formatCliValue(
        route ?? "",
      )}  ${formatCliValue(recommendation.title ?? "")}`,
    );
    if (recommendation.recommendedAction) {
      defaultRuntime.log(`  next ${formatCliValue(recommendation.recommendedAction)}`);
    }
  }
}

function printSummary(result: unknown) {
  const scorecard = (result as { scorecard?: Record<string, unknown> }).scorecard;
  const groups = (result as { groups?: Array<Record<string, unknown>> }).groups ?? [];
  defaultRuntime.log(
    `Active ${formatCliValue(scorecard?.activeRecommendations ?? 0)} | groups ${formatCliValue(
      scorecard?.groupedRecommendations ?? groups.length,
    )} | critical ${formatCliValue(scorecard?.criticalOpen ?? 0)} | high ${formatCliValue(
      scorecard?.highOpen ?? 0,
    )} | tests ${formatCliValue(scorecard?.testRequired ?? 0)} | approval ${formatCliValue(
      scorecard?.approvalRequired ?? 0,
    )}`,
  );
  if (groups.length === 0) {
    defaultRuntime.log("No grouped self-improvement recommendations.");
    return;
  }
  for (const group of groups) {
    const count = formatCliValue(group.count ?? 0);
    const priority = formatCliValue(group.priority ?? group.severity ?? "");
    const status = formatCliValue(group.status ?? "");
    const title = formatCliValue(group.title ?? "");
    const route = (group.route as { targetAgentLabel?: unknown } | undefined)?.targetAgentLabel;
    const confidence = formatConfidencePercent(
      (group.analysis as Record<string, unknown> | undefined)?.confidence,
    );
    defaultRuntime.log(
      `${priority}/${status}  x${count}${confidence ? `  ${confidence}` : ""}  ${formatCliValue(
        route ?? "",
      )}  ${title}`,
    );
  }
}

function printActionQueue(result: unknown) {
  const actionQueue =
    (result as { actionQueue?: Record<string, unknown> }).actionQueue ??
    (result as { scorecard?: { actionQueue?: Record<string, unknown> } }).scorecard?.actionQueue;
  const items = Array.isArray(actionQueue?.items)
    ? (actionQueue.items as Array<Record<string, unknown>>)
    : [];
  defaultRuntime.log(
    `Action Queue total ${formatCliValue(actionQueue?.total ?? 0)} | unassigned ${formatCliValue(
      actionQueue?.unassigned ?? 0,
    )} | overdue ${formatCliValue(actionQueue?.overdue ?? 0)} | proof missing ${formatCliValue(
      actionQueue?.proofMissing ?? 0,
    )} | ready ${formatCliValue(actionQueue?.readyToResolve ?? 0)}`,
  );
  if (items.length === 0) {
    defaultRuntime.log("No actionable self-improvement items.");
    return;
  }
  for (const item of items) {
    const actionability = item.actionability as Record<string, unknown> | undefined;
    const route = (item.route as { targetAgentLabel?: unknown } | undefined)?.targetAgentLabel;
    defaultRuntime.log(
      `${formatCliValue(item.kind ?? "")} ${formatCliValue(item.id ?? "")}  ${formatCliValue(
        item.priority ?? "",
      )}/${formatCliValue(item.status ?? "")}  owner ${formatCliValue(
        actionability?.ownerState ?? "unknown",
      )}  sla ${formatCliValue(actionability?.slaState ?? "unknown")}  proof ${formatCliValue(
        actionability?.proofState ?? "unknown",
      )}  closure ${formatCliValue(actionability?.closureState ?? "unknown")}  rank ${formatCliValue(
        actionability?.rank ?? 0,
      )}  ${formatCliValue(route ?? "")}  ${formatCliValue(item.title ?? "")}`,
    );
    if (actionability?.nextAction) {
      defaultRuntime.log(`  next ${formatCliValue(actionability.nextAction)}`);
    }
  }
}

function printScorecard(result: unknown) {
  const current = (result as { current?: Record<string, unknown> }).current;
  const scorecards = (result as { scorecards?: Array<Record<string, unknown>> }).scorecards ?? [];
  defaultRuntime.log(
    `Active ${formatCliValue(current?.activeRecommendations ?? 0)} | groups ${formatCliValue(
      current?.groupedRecommendations ?? 0,
    )} | critical ${formatCliValue(current?.criticalOpen ?? 0)} | high ${formatCliValue(
      current?.highOpen ?? 0,
    )} | tests ${formatCliValue(current?.testRequired ?? 0)} | approval ${formatCliValue(
      current?.approvalRequired ?? 0,
    )}`,
  );
  if (scorecards.length === 0) {
    defaultRuntime.log("No daily scorecard snapshots yet. Run analysis to write one.");
    return;
  }
  for (const entry of scorecards) {
    const scorecard = entry.scorecard as Record<string, unknown> | undefined;
    defaultRuntime.log(
      `${formatCliValue(entry.dateKey)}  active ${formatCliValue(
        scorecard?.activeRecommendations ?? 0,
      )}  groups ${formatCliValue(scorecard?.groupedRecommendations ?? 0)}  resolved24h ${formatCliValue(
        scorecard?.resolvedLast24h ?? 0,
      )}`,
    );
  }
}

function printOperationalHealth(result: unknown) {
  const current = (result as { current?: Record<string, unknown> }).current;
  const snapshots = (result as { snapshots?: Array<Record<string, unknown>> }).snapshots ?? [];
  const dimensions = Array.isArray(current?.dimensions)
    ? (current.dimensions as Array<Record<string, unknown>>)
    : [];
  defaultRuntime.log(
    `Operational health ${formatCliValue(current?.status ?? "blocked")} | score ${formatCliValue(
      current?.score ?? 0,
    )} | trend ${formatCliValue(current?.trend ?? "unknown")} | snapshots ${formatCliValue(snapshots.length)}`,
  );
  for (const dimension of dimensions) {
    defaultRuntime.log(
      `${formatCliValue(dimension.id ?? "")}  ${formatCliValue(dimension.status ?? "blocked")}  score ${formatCliValue(
        dimension.score ?? 0,
      )}  ${formatCliValue(dimension.summary ?? "")}`,
    );
    const blockers = Array.isArray(dimension.blockers)
      ? dimension.blockers.filter((item): item is string => typeof item === "string").slice(0, 3)
      : [];
    for (const blocker of blockers) {
      defaultRuntime.log(`  blocker ${blocker}`);
    }
  }
  const nextActions = Array.isArray(current?.nextActions)
    ? current.nextActions.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];
  if (nextActions.length > 0) {
    defaultRuntime.log(`Next: ${nextActions.join(" | ")}`);
  }
}

function printProductionCheck(result: unknown) {
  const check = result as Record<string, unknown>;
  const evidence = Array.isArray(check.evidence)
    ? (check.evidence as Array<Record<string, unknown>>)
    : [];
  defaultRuntime.log(
    `Production check ${formatCliValue(check.status ?? "blocked")} | ready ${formatCliValue(
      check.ready ?? false,
    )} | score ${formatCliValue(check.score ?? 0)} | evidence ${formatCliValue(evidence.length)}`,
  );
  const blockers = Array.isArray(check.blockers)
    ? check.blockers.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];
  for (const blocker of blockers) {
    defaultRuntime.log(`Blocker: ${blocker}`);
  }
  const warnings = Array.isArray(check.warnings)
    ? check.warnings.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];
  for (const warning of warnings) {
    defaultRuntime.log(`Warning: ${warning}`);
  }
  for (const item of evidence.slice(0, 8)) {
    defaultRuntime.log(
      `${formatCliValue(item.key ?? "")}  ${formatCliValue(item.status ?? "blocked")}  ${formatCliValue(
        item.summary ?? "",
      )}`,
    );
  }
}

function printMaintenanceResult(result: unknown) {
  const maintenance = result as Record<string, unknown>;
  const stores = Array.isArray(maintenance.stores)
    ? (maintenance.stores as Array<Record<string, unknown>>)
    : [];
  defaultRuntime.log(
    `Retention maintenance ${maintenance.applied ? "applied" : "dry run"} | pruned ${formatCliValue(
      maintenance.totalPruned ?? 0,
    )} | before ${formatCliValue(maintenance.totalBefore ?? 0)} | after ${formatCliValue(
      maintenance.totalAfter ?? 0,
    )}`,
  );
  for (const store of stores) {
    defaultRuntime.log(
      `${formatCliValue(store.store ?? "")}  ${formatCliValue(store.before ?? 0)} -> ${formatCliValue(
        store.after ?? 0,
      )}  pruned ${formatCliValue(store.pruned ?? 0)}  active ${formatCliValue(
        store.retainedActive ?? 0,
      )}  retention ${formatCliValue(store.retentionDays ?? 0)}d`,
    );
  }
  if (maintenance.auditEventId) {
    defaultRuntime.log(`Audit event: ${formatCliValue(maintenance.auditEventId)}`);
  }
}

function formatAuditEventDate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "unknown-time";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown-time" : date.toISOString();
}

function formatAuditMetadataValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return formatCliValue(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter(Boolean)
      .slice(0, 5);
    return values.length > 0 ? values.join(", ") : undefined;
  }
  return undefined;
}

function printAuditEvents(result: unknown) {
  const events = (result as { events?: Array<Record<string, unknown>> }).events ?? [];
  if (events.length === 0) {
    defaultRuntime.log("No self-improvement audit events.");
    return;
  }
  for (const event of events) {
    defaultRuntime.log(
      `${formatAuditEventDate(event.createdAt)}  ${formatCliValue(event.kind ?? "")}/${formatCliValue(
        event.actor ?? "",
      )}  ${formatCliValue(event.targetId ?? "")}  ${formatCliValue(event.summary ?? "")}`,
    );
    const metadata = event.metadata as Record<string, unknown> | undefined;
    const entries = metadata
      ? Object.entries(metadata)
          .map(([key, value]) => {
            const formatted = formatAuditMetadataValue(value);
            return formatted ? `${key}=${formatted}` : "";
          })
          .filter(Boolean)
          .slice(0, 8)
      : [];
    if (entries.length > 0) {
      defaultRuntime.log(`  metadata ${entries.join("; ")}`);
    }
  }
}

function formatAttemptProfile(attempt: Record<string, unknown>): string {
  const contextWindow =
    typeof attempt.contextWindow === "number"
      ? `${attempt.contextWindow.toLocaleString()} ctx`
      : undefined;
  const maxOutput =
    typeof attempt.maxOutputTokens === "number"
      ? `max ${attempt.maxOutputTokens.toLocaleString()}`
      : undefined;
  const temperature =
    typeof attempt.temperature === "number"
      ? `temp ${formatCliValue(attempt.temperature)}`
      : undefined;
  const topP =
    typeof attempt.topP === "number" ? `top_p ${formatCliValue(attempt.topP)}` : undefined;
  const timeout =
    typeof attempt.timeoutMs === "number"
      ? `timeout ${formatCliValue(attempt.timeoutMs)}ms`
      : undefined;
  const completion =
    typeof attempt.completionMs === "number"
      ? `completion ${formatCliValue(attempt.completionMs)}ms`
      : undefined;
  const preflightSource =
    typeof attempt.preflightSource === "string"
      ? `source ${formatCliValue(attempt.preflightSource)}`
      : undefined;
  const providerConfigured =
    typeof attempt.providerConfigured === "boolean"
      ? `provider ${attempt.providerConfigured ? "configured" : "default"}`
      : undefined;
  const parts = [
    typeof attempt.quantization === "string" ? attempt.quantization : undefined,
    typeof attempt.parameters === "string" ? attempt.parameters : undefined,
    contextWindow,
    maxOutput,
    temperature,
    topP,
    timeout,
    completion,
    preflightSource,
    providerConfigured,
  ].filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? ` | ${parts.join(" | ")}` : "";
}

function printAnalysis(result: unknown) {
  const analysis = result as Record<string, unknown>;
  const model = formatCliValue(analysis.modelId ?? analysis.reviewModelId ?? "deterministic");
  const tier = formatCliValue(analysis.modelTier ?? "none");
  const attempts = Array.isArray(analysis.attempts) ? analysis.attempts.length : 0;
  const preflight = formatCliValue(analysis.preflightStatus ?? "n/a");
  const confidence = formatConfidencePercent(analysis.confidence);
  const readiness =
    typeof analysis.readiness === "string"
      ? ` | readiness ${formatCliValue(analysis.readiness)} | ready ${formatCliValue(analysis.ready ?? false)}${
          analysis.readyTier && analysis.readyModelId
            ? ` via ${formatCliValue(analysis.readyTier)} ${formatCliValue(analysis.readyModelId)}`
            : ""
        }`
      : "";
  defaultRuntime.log(
    `Analysis ${formatCliValue(analysis.mode)} | groups ${formatCliValue(
      analysis.groupsAnalyzed ?? 0,
    )} | llm-reviewed ${formatCliValue(analysis.groupsReviewedByLlm ?? 0)} | local-reviewed ${formatCliValue(
      analysis.groupsReviewedByLocalLlm ?? 0,
    )} | attempts ${formatCliValue(attempts)} | schema ${formatCliValue(
      analysis.schemaValidated ?? false,
    )}${confidence ? ` | ${confidence}` : ""}${readiness} | preflight ${preflight} | tier ${tier} | model ${model} | proposals created ${formatCliValue(
      analysis.proposalsCreated ?? 0,
    )}`,
  );
  if (analysis.escalationReason) {
    defaultRuntime.log(`Escalation: ${formatCliValue(analysis.escalationReason)}`);
  }
  if (Array.isArray(analysis.attempts) && analysis.attempts.length > 0) {
    for (const attempt of analysis.attempts as Array<Record<string, unknown>>) {
      const preflightStatus = attempt.preflightStatus
        ? ` | preflight ${formatCliValue(attempt.preflightStatus)}${
            attempt.preflightMs !== undefined ? ` ${formatCliValue(attempt.preflightMs)}ms` : ""
          }`
        : "";
      defaultRuntime.log(
        `Attempt ${formatCliValue(attempt.attempt)} ${formatCliValue(attempt.tier)} ${formatCliValue(
          attempt.status,
        )} ${formatCliValue(attempt.modelId)}${formatAttemptProfile(attempt)}${preflightStatus}${
          attempt.diagnostic ? ` | diagnostic ${formatCliValue(attempt.diagnostic)}` : ""
        }${
          attempt.error ? ` | ${formatCliValue(attempt.error)}` : ""
        }${attempt.remediationHint ? ` | next ${formatCliValue(attempt.remediationHint)}` : ""}`,
      );
    }
  }
  if (analysis.fallbackReason) {
    defaultRuntime.log(`Model fallback: ${formatCliValue(analysis.fallbackReason)}`);
  }
  if (analysis.blockedPrimaryReason) {
    defaultRuntime.log(`Primary blocked: ${formatCliValue(analysis.blockedPrimaryReason)}`);
  }
}

function printModelPreflight(result: unknown) {
  const preflight = result as Record<string, unknown>;
  const attempts = Array.isArray(preflight.attempts)
    ? (preflight.attempts as Array<Record<string, unknown>>)
    : [];
  const readyVia =
    preflight.readyTier && preflight.readyModelId
      ? ` | ready via ${formatCliValue(preflight.readyTier)} ${formatCliValue(preflight.readyModelId)}`
      : "";
  defaultRuntime.log(
    `Model preflight ${formatCliValue(preflight.readiness ?? (preflight.ready ? "ready" : "blocked"))} | ready ${formatCliValue(preflight.ready ?? false)}${readyVia} | policy ${formatCliValue(
      preflight.reviewPolicy ?? "deterministic",
    )} | preflight ${formatCliValue(preflight.preflightStatus ?? "n/a")} | attempts ${formatCliValue(
      attempts.length,
    )} | schema ${formatCliValue(preflight.schemaValidated ?? false)}`,
  );
  if (preflight.escalationReason) {
    defaultRuntime.log(`Escalation: ${formatCliValue(preflight.escalationReason)}`);
  }
  for (const attempt of attempts) {
    const preflightStatus = attempt.preflightStatus
      ? ` | preflight ${formatCliValue(attempt.preflightStatus)}${
          attempt.preflightMs !== undefined ? ` ${formatCliValue(attempt.preflightMs)}ms` : ""
        }`
      : "";
    defaultRuntime.log(
      `Attempt ${formatCliValue(attempt.attempt)} ${formatCliValue(attempt.tier)} ${formatCliValue(
        attempt.status,
      )} ${formatCliValue(attempt.modelId)}${formatAttemptProfile(attempt)}${preflightStatus}${
        attempt.diagnostic ? ` | diagnostic ${formatCliValue(attempt.diagnostic)}` : ""
      }${
        attempt.error ? ` | ${formatCliValue(attempt.error)}` : ""
      }${attempt.remediationHint ? ` | next ${formatCliValue(attempt.remediationHint)}` : ""}`,
    );
  }
  if (preflight.fallbackReason) {
    defaultRuntime.log(`Model fallback: ${formatCliValue(preflight.fallbackReason)}`);
  }
  if (preflight.blockedPrimaryReason) {
    defaultRuntime.log(`Primary blocked: ${formatCliValue(preflight.blockedPrimaryReason)}`);
  }
}

function formatRatePercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "0%";
  }
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function printReviewerEvalResult(result: unknown) {
  const evalResult = result as Record<string, unknown>;
  const scorecard = evalResult.scorecard as Record<string, unknown> | undefined;
  const cases = Array.isArray(evalResult.cases)
    ? (evalResult.cases as Array<Record<string, unknown>>)
    : [];
  const p95 =
    typeof scorecard?.p95CompletionMs === "number"
      ? ` | p95 ${formatCliValue(scorecard.p95CompletionMs)}ms`
      : "";
  defaultRuntime.log(
    `Reviewer eval ${formatCliValue(evalResult.readiness ?? "blocked")} | ready ${formatCliValue(
      evalResult.ready ?? false,
    )} | fixture ${formatCliValue(evalResult.fixtureSet ?? "smoke")} | cases ${formatCliValue(
      scorecard?.casesPassed ?? 0,
    )}/${formatCliValue(scorecard?.casesTotal ?? cases.length)} | pass ${formatRatePercent(
      scorecard?.passRate,
    )} | schema ${formatRatePercent(scorecard?.schemaValidRate)} | safety ${formatRatePercent(
      scorecard?.safetyPassRate,
    )} | route ${formatRatePercent(scorecard?.routePreservationRate)}${p95} | model ${formatCliValue(
      evalResult.modelId ?? evalResult.reviewModelId ?? "n/a",
    )}`,
  );
  const failed = cases.filter((entry) => entry.passed === false).slice(0, 6);
  for (const entry of failed) {
    const diagnostics = Array.isArray(entry.diagnostics)
      ? entry.diagnostics.filter((item): item is string => typeof item === "string").join(", ")
      : "";
    defaultRuntime.log(
      `Failed ${formatCliValue(entry.caseId ?? "")}: ${diagnostics || "no diagnostic"}`,
    );
  }
  const diagnostics = Array.isArray(scorecard?.diagnostics)
    ? (scorecard.diagnostics as Array<Record<string, unknown>>)
    : [];
  if (diagnostics.length > 0) {
    defaultRuntime.log(
      `Diagnostics: ${diagnostics
        .slice(0, 6)
        .map((entry) => `${formatCliValue(entry.code)}=${formatCliValue(entry.count)}`)
        .join("; ")}`,
    );
  }
}

function printModelTemplate(result: unknown) {
  const template = result as ReturnType<typeof buildSelfImprovementModelTemplate>;
  defaultRuntime.log(`Primary review model: ${template.primary.providerRef}`);
  defaultRuntime.log(
    `Profile: ${template.primary.parameters}, ${template.primary.quantization}, context ${formatCliValue(
      template.primary.contextWindow,
    )}, max output ${formatCliValue(template.primary.maxOutputTokens)}`,
  );
  defaultRuntime.log(`Fallback review model: ${template.fallback.providerRef}`);
  defaultRuntime.log(`Triage model: ${template.triage.providerRef}`);
  defaultRuntime.log(`Strategic model: ${template.strategic.providerRef}`);
  defaultRuntime.log(`Optional external GPU model: ${template.optionalExternalGpu.providerRef}`);
  defaultRuntime.log(
    template.configPatch
      ? `Config patch:\n${JSON.stringify(template.configPatch, null, 2)}`
      : "Config patch: not required for the default local-only policy.",
  );
  defaultRuntime.log("Verification:");
  for (const command of template.verification) {
    defaultRuntime.log(`- ${command}`);
  }
  defaultRuntime.log("Safety:");
  for (const note of template.safety) {
    defaultRuntime.log(`- ${note}`);
  }
}

function printProposals(result: unknown) {
  const proposals = (result as { proposals?: Array<Record<string, unknown>> }).proposals ?? [];
  if (proposals.length === 0) {
    defaultRuntime.log("No self-improvement proposals.");
    return;
  }
  for (const proposal of proposals) {
    const route = (proposal.route as { targetAgentLabel?: unknown } | undefined)?.targetAgentLabel;
    defaultRuntime.log(
      `${formatCliValue(proposal.id ?? "")}  ${formatCliValue(proposal.kind ?? "")}/${formatCliValue(
        proposal.status ?? "",
      )}  ${formatCliValue(route ?? "")}  ${formatCliValue(proposal.title ?? "")}`,
    );
  }
}

function printCuratorProposals(result: unknown) {
  const proposals = (result as { proposals?: Array<Record<string, unknown>> }).proposals ?? [];
  if (proposals.length === 0) {
    defaultRuntime.log("No memory/skill curator proposals.");
    return;
  }
  for (const proposal of proposals) {
    const route = (proposal.route as { targetAgentLabel?: unknown } | undefined)?.targetAgentLabel;
    const workshop = proposal.workshopProposalId
      ? `  workshop ${formatCliValue(proposal.workshopProposalId)}:${formatCliValue(
          proposal.workshopProposalStatus ?? "pending",
        )}`
      : "";
    defaultRuntime.log(
      `${formatCliValue(proposal.id ?? "")}  curator ${formatCliValue(
        proposal.curatorStatus ?? "pending_review",
      )}  proposal ${formatCliValue(proposal.status ?? "")}  ${formatCliValue(route ?? "")}${workshop}  ${formatCliValue(
        proposal.title ?? "",
      )}`,
    );
  }
}

function printProposal(result: unknown) {
  const proposal = (result as { proposal?: Record<string, unknown> }).proposal;
  if (!proposal) {
    defaultRuntime.log("Proposal not found.");
    return;
  }
  defaultRuntime.log(`${formatCliValue(proposal.id)}: ${formatCliValue(proposal.title)}`);
  defaultRuntime.log(`${formatCliValue(proposal.kind)} | ${formatCliValue(proposal.status)}`);
  if (proposal.kind === "memory_skill") {
    defaultRuntime.log(
      `Curator ${formatCliValue(proposal.curatorStatus ?? "pending_review")} | workshop ${formatCliValue(
        proposal.workshopProposalId ?? "unlinked",
      )} ${formatCliValue(proposal.workshopProposalStatus ?? "")}`,
    );
  }
  defaultRuntime.log(formatCliValue(proposal.summary ?? ""));
  defaultRuntime.log(`Recommended action: ${formatCliValue(proposal.recommendedAction ?? "")}`);
}

async function runSelfImprovementCommand(
  opts: SelfImprovementOpts,
  action: () => Promise<unknown>,
  render?: (result: unknown) => void,
): Promise<void> {
  try {
    const result = await action();
    if (opts.json || !render) {
      defaultRuntime.writeJson(result);
      return;
    }
    render(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("__exit__:")) {
      throw error;
    }
    defaultRuntime.error(danger(formatCliValue(error)));
    defaultRuntime.exit(1);
  }
}

export function registerSelfImprovementCli(program: Command) {
  const selfImprovement = program
    .command("self-improvement")
    .description("Inspect and manage Self-Improvement Governor recommendations");

  addGatewayClientOptions(
    selfImprovement
      .command("scan")
      .description("Run the Self-Improvement Governor scan now")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli("selfImprovement.scan", opts, {}, { expectFinal: false }),
      (result) => {
        const scan = (result as { scan?: Record<string, unknown> }).scan;
        defaultRuntime.log(
          `Produced ${formatCliValue(scan?.produced ?? 0)} recommendation(s), ${formatCliValue(scan?.open ?? 0)} open.`,
        );
      },
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("list")
      .description("List Self-Improvement Governor recommendations")
      .option("--status <csv>", "Filter by status")
      .option("--severity <csv>", "Filter by severity")
      .option("--route <csv>", "Filter by route role")
      .option("--category <csv>", "Filter by category")
      .option("--limit <n>", "Maximum recommendations to return", "100")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementListOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.recommendations.list",
          opts,
          {
            status: parseCsv(opts.status) ?? ["open", "acknowledged"],
            severity: parseCsv(opts.severity),
            route: parseCsv(opts.route),
            category: parseCsv(opts.category),
            limit: parseLimit(opts.limit),
          },
          { expectFinal: false },
        ),
      printRecommendations,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("summary")
      .description("Show grouped Self-Improvement Governor recommendations and scorecard")
      .option("--status <csv>", "Filter by status")
      .option("--route <csv>", "Filter by route role")
      .option("--limit <n>", "Maximum groups to return", "20")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementSummaryOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.summary",
          opts,
          {
            status: parseCsv(opts.status),
            route: parseCsv(opts.route),
            limit: parseLimit(opts.limit),
          },
          { expectFinal: false },
        ),
      printSummary,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("opportunities")
      .description("List continuous-improvement opportunities without running implementation work")
      .option("--category <csv>", "Filter by intelligence category")
      .option("--route <csv>", "Filter by route role")
      .option("--status <csv>", "Filter by recommendation status")
      .option("--limit <n>", "Maximum opportunities to return", "50")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementOpportunitiesOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.recommendations.list",
          opts,
          {
            status: parseCsv(opts.status) ?? [
              "open",
              "acknowledged",
              "assigned",
              "in_progress",
              "reopened",
              "quarantined",
            ],
            route: parseCsv(opts.route),
            category: parseCsv(opts.category) ?? selfImprovementIntelligenceCategories(),
            limit: parseBoundedInteger(opts.limit, "--limit", 1, 500),
          },
          { expectFinal: false },
        ),
      printOpportunities,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("triage")
      .description("Show the prioritized Self-Improvement Governor action queue")
      .option("--route <csv>", "Filter by route role")
      .option("--status <csv>", "Filter by recommendation status")
      .option("--limit <n>", "Maximum queue items to return", "20")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementTriageOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.summary",
          opts,
          {
            route: parseCsv(opts.route),
            status: parseCsv(opts.status),
            limit: parseBoundedInteger(opts.limit, "--limit", 1, 100),
          },
          { expectFinal: false },
        ),
      printActionQueue,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("scorecard")
      .description("Show current and daily Self-Improvement Governor scorecards")
      .option("--days <n>", "Days of daily snapshots to return", "30")
      .option("--limit <n>", "Maximum snapshots to return", "30")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementScorecardOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.scorecard",
          opts,
          {
            days: parseBoundedInteger(opts.days, "--days", 1, 90),
            limit: parseBoundedInteger(opts.limit, "--limit", 1, 100),
          },
          { expectFinal: false },
        ),
      printScorecard,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("health")
      .description("Show Self-Improvement Governor operational health")
      .option("--days <n>", "Health snapshot window", "14")
      .option("--limit <n>", "Maximum health snapshots to return", "14")
      .option("--fail-on-degraded", "Exit nonzero unless operational health is ready", false)
      .option("--fail-on-blocked", "Exit nonzero when operational health is blocked", false)
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementHealthOpts) => {
    try {
      const result = await callGatewayFromCli(
        "selfImprovement.health",
        opts,
        {
          days: parseBoundedInteger(opts.days, "--days", 1, 90),
          limit: parseBoundedInteger(opts.limit, "--limit", 1, 100),
        },
        { expectFinal: false },
      );
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        printOperationalHealth(result);
      }
      const status = formatCliValue(
        (result as { current?: { status?: unknown } }).current?.status ?? "blocked",
      );
      if (opts.failOnDegraded && status !== "ready") {
        defaultRuntime.exit(1);
      }
      if (opts.failOnBlocked && status === "blocked") {
        defaultRuntime.exit(1);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("__exit__:")) {
        throw error;
      }
      defaultRuntime.error(danger(formatCliValue(error)));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    selfImprovement
      .command("production-check")
      .description("Run the Self-Improvement Governor production readiness gate")
      .option("--days <n>", "Health snapshot window", "14")
      .option("--limit <n>", "Maximum health snapshots to return", "14")
      .option("--fail-on-degraded", "Exit nonzero unless production check is ready", false)
      .option("--fail-on-blocked", "Exit nonzero when production check is blocked", false)
      .option("--require-model-ready", "Require current model readiness proof", false)
      .option("--require-evals-ready", "Require current reviewer eval proof", false)
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementProductionCheckOpts) => {
    try {
      const result = await callGatewayFromCli(
        "selfImprovement.productionCheck",
        opts,
        {
          days: parseBoundedInteger(opts.days, "--days", 1, 90),
          limit: parseBoundedInteger(opts.limit, "--limit", 1, 100),
          failOnDegraded: opts.failOnDegraded,
          failOnBlocked: opts.failOnBlocked,
          requireModelReady: opts.requireModelReady,
          requireEvalsReady: opts.requireEvalsReady,
        },
        { expectFinal: false },
      );
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        printProductionCheck(result);
      }
      const status = formatCliValue((result as { status?: unknown }).status ?? "blocked");
      if (opts.failOnDegraded && status !== "ready") {
        defaultRuntime.exit(1);
      }
      if (opts.failOnBlocked && status === "blocked") {
        defaultRuntime.exit(1);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("__exit__:")) {
        throw error;
      }
      defaultRuntime.error(danger(formatCliValue(error)));
      defaultRuntime.exit(1);
    }
  });

  addGatewayClientOptions(
    selfImprovement
      .command("maintain")
      .description("Run bounded Self-Improvement retention maintenance")
      .option("--dry-run", "Preview retention maintenance without writing stores", false)
      .option("--apply", "Apply retention maintenance and append sanitized audit metadata", false)
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementMaintenanceOpts) => {
    if (opts.apply && opts.dryRun) {
      throw new Error("Use either --apply or --dry-run, not both.");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.maintenance.run",
          opts,
          { apply: opts.apply === true },
          { expectFinal: false },
        ),
      printMaintenanceResult,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("audit-events")
      .description("List sanitized Self-Improvement Governor audit events")
      .option("--kind <csv>", "Filter by audit event kind")
      .option("--limit <n>", "Maximum audit events to return", "100")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementAuditEventsListOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.auditEvents.list",
          opts,
          {
            kind: parseCsv(opts.kind),
            limit: parseLimit(opts.limit),
          },
          { expectFinal: false },
        ),
      printAuditEvents,
    );
  });

  const models = selfImprovement
    .command("models")
    .description("Inspect read-only Self-Improvement Governor model setup helpers");

  models
    .command("template")
    .description("Print the recommended local-first Governor model config template")
    .option("--json", "Output JSON", false)
    .action(async (opts: SelfImprovementOpts) => {
      await runSelfImprovementCommand(
        opts,
        async () => buildSelfImprovementModelTemplate(),
        printModelTemplate,
      );
    });

  addGatewayClientOptions(
    selfImprovement
      .command("preflight")
      .description("Check Self-Improvement Governor review model readiness without generation")
      .option(
        "--approve-llm-review",
        "Approve one bounded hosted readiness check for this run",
        false,
      )
      .option("--model <modelId>", "Hosted model id to request when --hosted is used")
      .option("--review-model <modelId>", "Primary local-first review model id")
      .option("--fallback-model <modelId>", "Practical local fallback model id")
      .option("--strategic-model <modelId>", "Strategic local model id for major-change groups")
      .option("--strategic", "Check strategic local routing for major-change groups", false)
      .option("--hosted", "Check hosted review gating instead of local-first local models", false)
      .option(
        "--allow-strategic-local",
        "Allow strategic local review for major-change or critical groups",
        false,
      )
      .option(
        "--allow-hosted-escalation",
        "Allow hosted escalation after local attempts when explicitly approved",
        false,
      )
      .option("--reviewer-agent <agentId>", "Agent id whose model/auth profile should run review")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementPreflightOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.models.preflight",
          opts,
          {
            llm: opts.hosted,
            llmApproval: opts.approveLlmReview,
            modelId: opts.model,
            reviewModelId: opts.reviewModel,
            fallbackModelId: opts.fallbackModel,
            strategicModelId: opts.strategicModel,
            localFirst: !opts.hosted,
            allowStrategicLocal: opts.allowStrategicLocal,
            allowHostedEscalation: opts.allowHostedEscalation,
            strategic: opts.strategic,
            reviewerAgentId: opts.reviewerAgent,
          },
          { expectFinal: false },
        ),
      printModelPreflight,
    );
  });

  const evals = selfImprovement
    .command("evals")
    .description("Run bounded Self-Improvement Governor reviewer quality evals");

  addGatewayClientOptions(
    evals
      .command("run")
      .description("Run the local-first reviewer eval corpus and write a sanitized audit event")
      .option("--fixture-set <set>", "Eval fixture set: smoke|core|all", "smoke")
      .option("--limit <n>", "Maximum eval cases to run", "3")
      .option("--approve-llm-review", "Approve hosted escalation if explicitly allowed", false)
      .option("--review-model <modelId>", "Primary local-first review model id")
      .option("--fallback-model <modelId>", "Practical local fallback model id")
      .option("--strategic-model <modelId>", "Strategic local model id for major-change groups")
      .option("--local-first", "Prefer local Governor review before hosted escalation", true)
      .option(
        "--allow-strategic-local",
        "Allow strategic local review for major-change or critical groups",
        false,
      )
      .option(
        "--allow-hosted-escalation",
        "Allow hosted escalation after local attempts when explicitly approved",
        false,
      )
      .option("--reviewer-agent <agentId>", "Agent id whose model/auth profile should run review")
      .option("--fail-on-threshold", "Return an RPC error when readiness is not ready", false)
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementEvalRunOpts) => {
    const rpcOpts: SelfImprovementEvalRunOpts = {
      ...opts,
      timeout:
        !opts.timeout || opts.timeout === "30000"
          ? formatCliValue(SELF_IMPROVEMENT_EVAL_RPC_TIMEOUT_MS)
          : opts.timeout,
    };
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.evals.run",
          rpcOpts,
          {
            fixtureSet: opts.fixtureSet,
            limit: parseBoundedInteger(opts.limit, "--limit", 1, 50),
            reviewModelId: opts.reviewModel,
            fallbackModelId: opts.fallbackModel,
            strategicModelId: opts.strategicModel,
            localFirst: opts.localFirst !== false,
            allowStrategicLocal: opts.allowStrategicLocal,
            allowHostedEscalation: opts.allowHostedEscalation,
            llmApproval: opts.approveLlmReview,
            reviewerAgentId: opts.reviewerAgent,
            failOnThreshold: opts.failOnThreshold,
          },
          { expectFinal: false },
        ),
      printReviewerEvalResult,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("analyze")
      .description("Run bounded analysis, write a scorecard snapshot, and generate proposals")
      .option("--limit <n>", "Maximum groups to analyze", "25")
      .option(
        "--llm",
        "Request hosted LLM analysis; also requires hosted escalation allowance, approval, and env gate",
        false,
      )
      .option("--approve-llm-review", "Approve one bounded LLM reviewer call for this run", false)
      .option("--model <modelId>", "Model id to request for LLM analysis")
      .option("--review-model <modelId>", "Primary local-first review model id")
      .option("--fallback-model <modelId>", "Practical local fallback model id")
      .option("--strategic-model <modelId>", "Strategic local model id for major-change groups")
      .option("--local-first", "Prefer local Governor review before hosted escalation", false)
      .option(
        "--allow-strategic-local",
        "Allow strategic local review for major-change or critical groups",
        false,
      )
      .option(
        "--allow-hosted-escalation",
        "Allow hosted escalation after local attempts when explicitly approved",
        false,
      )
      .option("--reviewer-agent <agentId>", "Agent id whose model/auth profile should run review")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementAnalyzeOpts) => {
    const rpcOpts: SelfImprovementAnalyzeOpts = {
      ...opts,
      timeout:
        !opts.timeout || opts.timeout === "30000"
          ? formatCliValue(SELF_IMPROVEMENT_ANALYSIS_RPC_TIMEOUT_MS)
          : opts.timeout,
    };
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.analysis.run",
          rpcOpts,
          {
            limit: parseBoundedInteger(opts.limit, "--limit", 1, 50),
            llm: opts.llm,
            llmApproval: opts.approveLlmReview,
            modelId: opts.model,
            reviewModelId: opts.reviewModel,
            fallbackModelId: opts.fallbackModel,
            strategicModelId: opts.strategicModel,
            localFirst: opts.localFirst,
            allowStrategicLocal: opts.allowStrategicLocal,
            allowHostedEscalation: opts.allowHostedEscalation,
            reviewerAgentId: opts.reviewerAgent,
          },
          { expectFinal: false },
        ),
      printAnalysis,
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("show")
      .description("Show one Self-Improvement Governor recommendation")
      .argument("<id>", "Recommendation id")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.recommendations.get",
          opts,
          { id },
          { expectFinal: false },
        ),
      (result) => {
        const recommendation = (result as { recommendation?: Record<string, unknown> })
          .recommendation;
        if (!recommendation) {
          defaultRuntime.log("Recommendation not found.");
          return;
        }
        defaultRuntime.log(
          `${formatCliValue(recommendation.id)}: ${formatCliValue(recommendation.title)}`,
        );
        defaultRuntime.log(formatCliValue(recommendation.summary ?? ""));
        defaultRuntime.log(
          `Recommended action: ${formatCliValue(recommendation.recommendedAction ?? "")}`,
        );
      },
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("update")
      .description("Update recommendation status")
      .argument("<id>", "Recommendation id")
      .requiredOption(
        "--status <status>",
        "open|acknowledged|assigned|in_progress|reopened|quarantined|resolved|dismissed",
      )
      .option("--note <text>", "Append an operator note")
      .option("--assign <agentId>", "Record the assigned target agent id")
      .option("--claimed-by <name>", "Record the owner claiming follow-up")
      .option("--proof <text>", "Attach resolution proof")
      .option("--dismissal-reason <text>", "Attach dismissal reason")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementUpdateOpts) => {
    const status = opts.status?.trim();
    if (!status) {
      throw new Error(
        `--status is required. Example: ${formatCliCommand("openclaw self-improvement update <id> --status acknowledged")}.`,
      );
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.recommendations.update",
          opts,
          {
            id,
            status,
            note: opts.note,
            assignedTargetAgentId: opts.assign,
            claimedBy: opts.claimedBy,
            resolutionProof: opts.proof,
            dismissalReason: opts.dismissalReason,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("assign")
      .description("Assign a recommendation to an owner without running implementation work")
      .argument("<id>", "Recommendation id")
      .requiredOption("--agent <agentId>", "Target agent id")
      .option("--claimed-by <name>", "Record the owner claiming follow-up")
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementAssignOpts) => {
    const agent = opts.agent?.trim();
    if (!agent) {
      throw new Error("--agent is required for assignment");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.recommendations.update",
          opts,
          {
            id,
            status: "assigned",
            note: opts.note,
            assignedTargetAgentId: agent,
            claimedBy: opts.claimedBy,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  addGatewayClientOptions(
    selfImprovement
      .command("prove")
      .description("Attach proof to a recommendation, optionally resolving it")
      .argument("<id>", "Recommendation id")
      .requiredOption("--proof <text>", "Resolution or verification proof")
      .option("--resolve", "Resolve after attaching proof", false)
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementProveOpts) => {
    const proof = opts.proof?.trim();
    if (!proof) {
      throw new Error("--proof is required");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.recommendations.update",
          opts,
          {
            id,
            status: opts.resolve ? "resolved" : "in_progress",
            note: opts.note,
            resolutionProof: proof,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  const groups = selfImprovement
    .command("groups")
    .description("Manage grouped Self-Improvement Governor recommendations");

  addGatewayClientOptions(
    groups
      .command("update")
      .description("Update every recommendation in a group")
      .argument("<id>", "Group id or group key")
      .requiredOption(
        "--status <status>",
        "open|acknowledged|assigned|in_progress|reopened|quarantined|resolved|dismissed",
      )
      .option("--note <text>", "Append an operator note")
      .option("--assign <agentId>", "Record the assigned target agent id")
      .option("--claimed-by <name>", "Record the owner claiming follow-up")
      .option("--proof <text>", "Attach resolution proof")
      .option("--dismissal-reason <text>", "Attach dismissal reason")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementUpdateOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.groups.update",
          opts,
          {
            id,
            status: opts.status,
            note: opts.note,
            assignedTargetAgentId: opts.assign,
            claimedBy: opts.claimedBy,
            resolutionProof: opts.proof,
            dismissalReason: opts.dismissalReason,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  addGatewayClientOptions(
    groups
      .command("prove")
      .description("Attach proof to every recommendation in a group, optionally resolving it")
      .argument("<id>", "Group id or group key")
      .requiredOption("--proof <text>", "Resolution or verification proof")
      .option("--resolve", "Resolve after attaching proof", false)
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementProveOpts) => {
    const proof = opts.proof?.trim();
    if (!proof) {
      throw new Error("--proof is required");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.groups.update",
          opts,
          {
            id,
            status: opts.resolve ? "resolved" : "in_progress",
            note: opts.note,
            resolutionProof: proof,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  const proposals = selfImprovement
    .command("proposals")
    .description("Inspect and manage Self-Improvement Governor proposals");

  addGatewayClientOptions(
    proposals
      .command("list")
      .description("List self-improvement proposals")
      .option("--status <csv>", "Filter by proposal status")
      .option("--kind <csv>", "Filter by proposal kind")
      .option("--limit <n>", "Maximum proposals to return", "100")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementProposalListOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.proposals.list",
          opts,
          {
            status: parseCsv(opts.status) ?? ["pending", "acknowledged"],
            kind: parseCsv(opts.kind),
            limit: parseLimit(opts.limit),
          },
          { expectFinal: false },
        ),
      printProposals,
    );
  });

  addGatewayClientOptions(
    proposals
      .command("show")
      .description("Show one self-improvement proposal")
      .argument("<id>", "Proposal id")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.proposals.get",
          opts,
          { id },
          { expectFinal: false },
        ),
      printProposal,
    );
  });

  addGatewayClientOptions(
    proposals
      .command("update")
      .description("Update proposal status")
      .argument("<id>", "Proposal id")
      .requiredOption("--status <status>", "pending|acknowledged|approved|rejected|superseded")
      .option("--note <text>", "Append an operator note")
      .option("--proof <text>", "Attach approval proof")
      .option("--dismissal-reason <text>", "Attach dismissal reason")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementProposalUpdateOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.proposals.update",
          opts,
          {
            id,
            status: opts.status,
            note: opts.note,
            approvalProof: opts.proof,
            dismissalReason: opts.dismissalReason,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  const curator = selfImprovement
    .command("curator")
    .description("Review memory and Skill Workshop curation proposals without writing skills");

  addGatewayClientOptions(
    curator
      .command("list")
      .description("List memory/skill proposals waiting for curator review")
      .option("--status <csv>", "Filter by curator status")
      .option("--limit <n>", "Maximum curator proposals to return", "100")
      .option("--json", "Output JSON", false),
  ).action(async (opts: SelfImprovementCuratorListOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.curator.list",
          opts,
          {
            status: parseCsv(opts.status),
            limit: parseLimit(opts.limit),
          },
          { expectFinal: false },
        ),
      printCuratorProposals,
    );
  });

  addGatewayClientOptions(
    curator
      .command("show")
      .description("Show one memory/skill curator proposal")
      .argument("<id>", "Proposal id")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementOpts) => {
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.curator.get",
          opts,
          { id },
          { expectFinal: false },
        ),
      printProposal,
    );
  });

  addGatewayClientOptions(
    curator
      .command("accept")
      .description("Accept a memory/skill proposal for pending Skill Workshop work")
      .argument("<id>", "Proposal id")
      .requiredOption("--proof <text>", "Review proof for accepting the proposal")
      .option("--workshop-proposal-id <id>", "Pending Skill Workshop proposal id")
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementCuratorAcceptOpts) => {
    const proof = opts.proof?.trim();
    if (!proof) {
      throw new Error("--proof is required");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.curator.update",
          opts,
          {
            id,
            curatorStatus: "accepted_for_workshop",
            proof,
            workshopProposalId: opts.workshopProposalId,
            workshopProposalStatus: opts.workshopProposalId ? "pending" : undefined,
            note: opts.note,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  addGatewayClientOptions(
    curator
      .command("reject")
      .description("Reject a memory/skill curator proposal with a durable reason")
      .argument("<id>", "Proposal id")
      .requiredOption("--reason <text>", "Reason for rejection")
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementCuratorRejectOpts) => {
    const reason = opts.reason?.trim();
    if (!reason) {
      throw new Error("--reason is required");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.curator.update",
          opts,
          {
            id,
            curatorStatus: "rejected",
            reason,
            note: opts.note,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  addGatewayClientOptions(
    curator
      .command("workshop-link")
      .description("Link an accepted memory/skill proposal to a pending Skill Workshop proposal")
      .argument("<id>", "Proposal id")
      .requiredOption("--workshop-proposal-id <id>", "Pending Skill Workshop proposal id")
      .requiredOption("--proof <text>", "Review proof for the pending workshop link")
      .option("--workshop-status <status>", "pending|quarantined|applied|rejected", "pending")
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementCuratorWorkshopLinkOpts) => {
    const proof = opts.proof?.trim();
    const workshopProposalId = opts.workshopProposalId?.trim();
    if (!proof) {
      throw new Error("--proof is required");
    }
    if (!workshopProposalId) {
      throw new Error("--workshop-proposal-id is required");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.curator.update",
          opts,
          {
            id,
            curatorStatus: "accepted_for_workshop",
            proof,
            workshopProposalId,
            workshopProposalStatus: opts.workshopStatus,
            note: opts.note,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });

  addGatewayClientOptions(
    curator
      .command("promote-proof")
      .description("Attach proof that an approved Skill Workshop item was promoted")
      .argument("<id>", "Proposal id")
      .requiredOption("--proof <text>", "Promotion proof")
      .option("--workshop-proposal-id <id>", "Skill Workshop proposal id")
      .option("--workshop-status <status>", "pending|quarantined|applied|rejected", "applied")
      .option("--note <text>", "Append an operator note")
      .option("--json", "Output JSON", false),
  ).action(async (id: string, opts: SelfImprovementCuratorPromoteOpts) => {
    const proof = opts.proof?.trim();
    if (!proof) {
      throw new Error("--proof is required");
    }
    await runSelfImprovementCommand(
      opts,
      async () =>
        await callGatewayFromCli(
          "selfImprovement.curator.update",
          opts,
          {
            id,
            curatorStatus: "promoted",
            proof,
            workshopProposalId: opts.workshopProposalId,
            workshopProposalStatus: opts.workshopStatus,
            note: opts.note,
          },
          { expectFinal: false },
        ),
      () => defaultRuntime.log("ok"),
    );
  });
}
