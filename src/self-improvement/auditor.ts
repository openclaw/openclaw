import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { listSelfImprovementAuditEvents } from "./audit-events.js";
import { resolveSelfImprovementRoute } from "./routing.js";
import { buildSelfImprovementSafety } from "./safety.js";
import {
  readSkillWorkshopProposalSnapshots,
  type SkillWorkshopProposalSnapshot,
} from "./skill-workshop.js";
import { deriveSelfImprovementGroupKey } from "./summary.js";
import { sanitizeRecommendationText, sanitizeRecommendationTexts } from "./text.js";
import type {
  SelfImprovementRecommendationAnalysis,
  SelfImprovementRecommendation,
  SelfImprovementRecommendationCategory,
  SelfImprovementRecommendationEffort,
  SelfImprovementRecommendationImpact,
  SelfImprovementRecommendationRoute,
  SelfImprovementRecommendationSeverity,
  SelfImprovementRecommendationSource,
  SelfImprovementAuditEvent,
} from "./types.js";

const ACTIVE_STALE_MS = 60 * 60_000;
const SKILL_WORKSHOP_PENDING_STALE_MS = 24 * 60 * 60_000;

const SEVERITY_ORDER: Record<SelfImprovementRecommendationSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export type SelfImprovementAuditInput = {
  cfg: OpenClawConfig;
  stateDir: string;
  tasks: TaskRecord[];
  cronJobs?: CronJob[];
  now?: number;
  auditEvents?: SelfImprovementAuditEvent[];
  skillWorkshopProposals?: SkillWorkshopProposalSnapshot[];
};

export type SelfImprovementAuditResult = {
  recommendations: SelfImprovementRecommendation[];
  inspected: {
    tasks: number;
    cronJobs: number;
    auditEvents: number;
    skillWorkshopProposals: number;
  };
};

type RecommendationDraft = {
  category: SelfImprovementRecommendationCategory;
  severity: SelfImprovementRecommendationSeverity;
  priority?: SelfImprovementRecommendationSeverity;
  impact?: SelfImprovementRecommendationImpact;
  effort?: SelfImprovementRecommendationEffort;
  groupTitle?: string;
  title: string;
  summary: string;
  source: SelfImprovementRecommendationSource;
  route: SelfImprovementRecommendationRoute;
  recommendedAction: string;
  requiredEvidence: string[];
  evidence: string[];
  confidence?: number;
};

function taskUpdatedAt(task: TaskRecord): number {
  return task.lastEventAt ?? task.endedAt ?? task.startedAt ?? task.createdAt;
}

function hashRecommendation(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildFingerprint(params: {
  category: SelfImprovementRecommendationCategory;
  source: SelfImprovementRecommendationSource;
  title: string;
}): string {
  return hashRecommendation(
    [
      params.category,
      params.source.kind,
      params.source.taskId,
      params.source.runId,
      params.source.cronJobId,
      params.source.proposalId,
      params.source.agentId,
      params.title,
    ]
      .filter(Boolean)
      .join(":"),
  );
}

function recommendationId(fingerprint: string): string {
  return `sir_${fingerprint.slice(0, 16)}`;
}

function categoryLabel(category: SelfImprovementRecommendationCategory): string {
  return category.replace(/_/g, " ");
}

function defaultImpact(
  severity: SelfImprovementRecommendationSeverity,
): SelfImprovementRecommendationImpact {
  return severity === "critical" || severity === "high" ? "high" : "medium";
}

function defaultEffort(
  category: SelfImprovementRecommendationCategory,
): SelfImprovementRecommendationEffort {
  switch (category) {
    case "instruction_adherence":
    case "knowledge_hygiene":
    case "outcome_measurement":
    case "user_correction":
    case "skill_workshop":
      return "small";
    case "major_change":
    case "capability_evolution":
    case "architecture_simplification":
      return "large";
    default:
      return "medium";
  }
}

function safetyEvidence(category: SelfImprovementRecommendationCategory): string[] {
  switch (category) {
    case "task_reliability":
    case "model_routing":
    case "efficiency_opportunity":
    case "architecture_simplification":
    case "major_change":
      return [
        "Reproduce or inspect the underlying evidence.",
        "Add a targeted regression test or operator approval before code/config changes.",
      ];
    case "smoke_failure":
      return [
        "Rerun the affected dashboard/mobile smoke.",
        "Attach the smoke command and result before marking resolved.",
      ];
    case "verification_gap":
      return [
        "Identify missing verification.",
        "Run the narrowest OpenClaw test wrapper that proves the behavior.",
      ];
    case "stale_work":
      return [
        "Confirm the run is genuinely stale.",
        "Cancel/retry only through normal task controls or explicit operator approval.",
      ];
    case "skill_workshop":
      return [
        "Review pending/quarantined proposal in Skill Workshop.",
        "Keep any skill write in pending mode until approved.",
      ];
    case "user_correction":
      return [
        "Review repeated correction evidence.",
        "Promote only bounded procedural memory through Skill Workshop pending mode.",
      ];
    case "project_health":
      return [
        "Review affected project/agent health evidence.",
        "Sequence remediation through the Program Manager route.",
      ];
    case "instruction_adherence":
      return [
        "Review the repeated instruction miss evidence.",
        "Create only bounded procedural-memory proposals in Skill Workshop pending mode.",
      ];
    case "workflow_simplification":
    case "agent_minimization":
    case "capability_evolution":
      return [
        "Compare the current workflow to simpler OpenClaw-native primitives.",
        "Require explicit approval before replacing agents, skills, or runtime behavior.",
      ];
    case "knowledge_hygiene":
      return [
        "Review stale or conflicting memory, skill, or doc evidence.",
        "Route any update through the Memory/Knowledge Curator and pending review.",
      ];
    case "risk_prevention":
      return [
        "Identify the guardrail, secret, destructive-action, or approval gap.",
        "Add tests or an explicit operator approval record before changing code/config.",
      ];
    case "outcome_measurement":
      return [
        "Define the metric or baseline that proves day-over-day improvement.",
        "Attach before/after evidence before marking the recommendation resolved.",
      ];
  }
}

function buildDeterministicAnalysis(params: {
  draft: RecommendationDraft;
  now: number;
  evidenceCount: number;
  safetyNotes: string[];
}): SelfImprovementRecommendationAnalysis {
  return {
    mode: "deterministic",
    summary: `${categoryLabel(
      params.draft.category,
    )} recommendation routed to ${params.draft.route.targetAgentLabel} from ${params.evidenceCount} evidence item(s).`,
    generatedAt: params.now,
    confidence: params.draft.confidence ?? 0.8,
    promptVersion: "self-improvement-deterministic-v1",
    evidenceCount: params.evidenceCount,
    safetyNotes: params.safetyNotes,
  };
}

function buildRecommendation(
  draft: RecommendationDraft,
  now: number,
): SelfImprovementRecommendation {
  const title = sanitizeRecommendationText(draft.title, 180);
  const summary = sanitizeRecommendationText(draft.summary, 640);
  const recommendedAction = sanitizeRecommendationText(draft.recommendedAction, 640);
  const evidence = sanitizeRecommendationTexts(draft.evidence, 300);
  const requiredEvidence = sanitizeRecommendationTexts(
    draft.requiredEvidence.length > 0 ? draft.requiredEvidence : safetyEvidence(draft.category),
    220,
  );
  const groupTitle = sanitizeRecommendationText(draft.groupTitle ?? title, 180);
  const source = {
    ...draft.source,
    label: sanitizeRecommendationText(draft.source.label, 180),
  };
  const fingerprint = buildFingerprint({ category: draft.category, source, title });
  const safety = buildSelfImprovementSafety({
    category: draft.category,
    route: draft.route,
  });
  const recommendation: SelfImprovementRecommendation = {
    id: recommendationId(fingerprint),
    fingerprint,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "open",
    title,
    summary,
    category: draft.category,
    severity: draft.severity,
    criticality: draft.severity,
    priority: draft.priority ?? draft.severity,
    impact: draft.impact ?? defaultImpact(draft.severity),
    effort: draft.effort ?? defaultEffort(draft.category),
    confidence: draft.confidence ?? 0.8,
    groupKey: "",
    groupTitle,
    recurrenceCount: 1,
    source,
    route: draft.route,
    recommendedAction,
    requiredEvidence,
    safety,
    analysis: buildDeterministicAnalysis({
      draft,
      now,
      evidenceCount: evidence.length,
      safetyNotes: [
        "Recommendation-only; no direct merge, push, release, or skill write.",
        safety.requiresTests
          ? "Requires test or smoke proof before resolution."
          : "Tests are required if follow-up changes code or config.",
        safety.requiresApproval
          ? "Requires operator approval before code/config/skill changes."
          : "Can be reviewed by the routed owner without direct mutation.",
      ],
    }),
    evidence,
  };
  recommendation.groupKey = deriveSelfImprovementGroupKey(recommendation);
  return recommendation;
}

function taskTitle(task: TaskRecord): string {
  return (
    sanitizeRecommendationText(task.label, 120) ||
    sanitizeRecommendationText(task.task, 120) ||
    task.taskId
  );
}

function taskSource(task: TaskRecord): SelfImprovementRecommendationSource {
  return {
    kind: "task",
    label: taskTitle(task),
    taskId: task.taskId,
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    sessionKey: task.requesterSessionKey,
  };
}

function taskText(task: TaskRecord): string {
  return [
    task.taskKind,
    task.label,
    task.task,
    task.progressSummary,
    task.terminalSummary,
    task.blockedReason,
    task.error,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function looksLikeSmokeTask(task: TaskRecord): boolean {
  return /\b(dashboard|control[-\s]?ui|mobile|android|ios|smoke)\b/.test(taskText(task));
}

function looksLikeModelRoutingIssue(task: TaskRecord): boolean {
  return /\b(model|provider|routing|fallback|timeout|timed out|rate limit|context length|auth|429|503)\b/.test(
    taskText(task),
  );
}

function looksLikeUserCorrection(task: TaskRecord): boolean {
  return /\b(user correction|correction|corrected|redo|wrong|regression|please fix|you changed|reverted)\b/.test(
    taskText(task),
  );
}

function auditTask(task: TaskRecord, params: SelfImprovementAuditInput & { now: number }) {
  const route = (category: SelfImprovementRecommendationCategory) =>
    resolveSelfImprovementRoute({ cfg: params.cfg, category });
  const drafts: RecommendationDraft[] = [];
  const title = taskTitle(task);
  const evidence = sanitizeRecommendationTexts(
    [
      `Task ${task.taskId} status: ${task.status}`,
      task.error,
      task.blockedReason,
      task.terminalSummary,
      task.progressSummary,
    ],
    300,
  );
  if (task.status === "succeeded" && task.terminalOutcome === "blocked") {
    drafts.push({
      category: "task_reliability",
      severity: "high",
      title: `Blocked task needs owner follow-up: ${title}`,
      summary:
        "A task completed with a blocked outcome. The governor is routing a recommendation instead of changing production state.",
      source: taskSource(task),
      route: route("task_reliability"),
      recommendedAction:
        "Review the blocked reason, decide whether this needs implementation, QA proof, or prioritization, and route the next task explicitly.",
      requiredEvidence: safetyEvidence("task_reliability"),
      evidence,
    });
  }
  if (task.status === "failed" || task.status === "timed_out" || task.status === "lost") {
    const category = looksLikeSmokeTask(task)
      ? "smoke_failure"
      : looksLikeModelRoutingIssue(task)
        ? "model_routing"
        : "task_reliability";
    drafts.push({
      category,
      severity: task.status === "timed_out" || category === "smoke_failure" ? "high" : "medium",
      title:
        category === "smoke_failure"
          ? `Failed smoke needs verification owner: ${title}`
          : category === "model_routing"
            ? `Model routing or timeout issue needs inspection: ${title}`
            : `Failed task needs reliability review: ${title}`,
      summary:
        "A failed or timed-out task was found in the task ledger. The governor records an explicit recommendation for review and proof.",
      source: taskSource(task),
      route: route(category),
      recommendedAction:
        category === "smoke_failure"
          ? "Have the QA Test Agent rerun the failing smoke and identify the smallest fix or verification gap."
          : category === "model_routing"
            ? "Have the Builder Agent inspect provider routing, timeout, and fallback behavior before proposing a code/config change."
            : "Inspect the failure pattern and create an implementation or verification proposal with targeted tests.",
      requiredEvidence: safetyEvidence(category),
      evidence,
    });
  }
  if (
    (task.status === "queued" || task.status === "running") &&
    params.now - taskUpdatedAt(task) > ACTIVE_STALE_MS
  ) {
    drafts.push({
      category: "stale_work",
      severity: "high",
      title: `Stale working run needs sequencing decision: ${title}`,
      summary:
        "A queued or running task has not emitted recent progress. The governor recommends review through normal task controls.",
      source: taskSource(task),
      route: route("stale_work"),
      recommendedAction:
        "Have the Program Manager decide whether to wait, retry, or cancel using normal OpenClaw task controls.",
      requiredEvidence: safetyEvidence("stale_work"),
      evidence: [
        ...evidence,
        `Last task update age: ${Math.round((params.now - taskUpdatedAt(task)) / 60_000)} minutes`,
      ],
    });
  }
  return drafts;
}

function auditRepeatedCorrections(
  tasks: TaskRecord[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft[] {
  const candidates = tasks.filter(looksLikeUserCorrection);
  const byAgent = new Map<string, TaskRecord[]>();
  for (const task of candidates) {
    const key = task.agentId ?? task.ownerKey ?? "unknown";
    byAgent.set(key, [...(byAgent.get(key) ?? []), task]);
  }
  const drafts: RecommendationDraft[] = [];
  for (const [agentId, agentTasks] of byAgent) {
    if (agentTasks.length < 2) {
      continue;
    }
    drafts.push({
      category: "user_correction",
      severity: "medium",
      title: `Repeated corrections detected for ${agentId}`,
      summary:
        "Multiple recent task records include correction-like language. This should become a bounded procedural-memory proposal only after curator review.",
      source: {
        kind: "task_group",
        label: `Repeated corrections for ${agentId}`,
        agentId,
      },
      route: resolveSelfImprovementRoute({
        cfg: params.cfg,
        category: "user_correction",
      }),
      recommendedAction:
        "Have the Memory/Knowledge Curator review the pattern and, if valid, create a Skill Workshop pending proposal instead of writing directly to skills.",
      requiredEvidence: safetyEvidence("user_correction"),
      evidence: agentTasks.slice(0, 5).map((task) => `${task.taskId}: ${taskTitle(task)}`),
      confidence: 0.65,
    });
  }
  return drafts;
}

type ContinuousImprovementTheme = {
  category: SelfImprovementRecommendationCategory;
  severity: SelfImprovementRecommendationSeverity;
  title: string;
  summary: string;
  sourceKind: SelfImprovementRecommendationSource["kind"];
  evidenceLabel: string;
  pattern: RegExp;
  minimumMatches: number;
  recommendedAction: string;
  requiredEvidence: string[];
  impact?: SelfImprovementRecommendationImpact;
  effort?: SelfImprovementRecommendationEffort;
  confidence?: number;
};

const CONTINUOUS_IMPROVEMENT_THEMES: ContinuousImprovementTheme[] = [
  {
    category: "efficiency_opportunity",
    severity: "medium",
    title: "Repeated efficiency signals need a safer workflow proposal",
    summary:
      "Recent task evidence mentions latency, cost, duplicate work, batching, timeout, or token waste. The governor is routing a recommendation to improve throughput without uncontrolled changes.",
    sourceKind: "workflow",
    evidenceLabel: "Efficiency opportunity signals",
    pattern:
      /\b(slow|latency|cost|expensive|token|duplicate|repeated|batch|timeout|timed out|too many tool|redundant|manual loop)\b/,
    minimumMatches: 2,
    recommendedAction:
      "Have the Builder Agent propose the smallest measurable workflow or runtime efficiency improvement, with before/after metrics and targeted tests.",
    requiredEvidence: safetyEvidence("efficiency_opportunity"),
    impact: "high",
    effort: "medium",
    confidence: 0.6,
  },
  {
    category: "project_health",
    severity: "medium",
    title: "Project or agent health gap needs sequencing review",
    summary:
      "Recent task evidence mentions project health, agent health, missing ownership, or an unsequenced operational gap.",
    sourceKind: "agent",
    evidenceLabel: "Project and agent health signals",
    pattern:
      /\b(project health|agent health|health gap|missing owner|unowned|ownership gap|stale project|agent gap)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have the Program Manager sequence ownership, priority, and verification before any implementation follow-up.",
    requiredEvidence: safetyEvidence("project_health"),
    confidence: 0.6,
  },
  {
    category: "instruction_adherence",
    severity: "high",
    title: "Repeated instruction-adherence misses need procedural memory",
    summary:
      "Recent task evidence mentions missed repo instructions, wrong wrappers, or required response fields. This should become bounded procedural memory after curator review.",
    sourceKind: "instruction",
    evidenceLabel: "Instruction-adherence signals",
    pattern:
      /\b(agents\.md|wrong test wrapper|raw vitest|ignored instruction|did not follow|forgot|completion grade|criticality|repo rule|oxfmt|prettier)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have the Memory/Knowledge Curator draft a pending Skill Workshop proposal that reinforces the repeated instruction without broad prompt bloat.",
    requiredEvidence: safetyEvidence("instruction_adherence"),
    impact: "high",
    effort: "small",
    confidence: 0.65,
  },
  {
    category: "workflow_simplification",
    severity: "medium",
    title: "Workflow simplification opportunity needs sequencing review",
    summary:
      "Recent task evidence suggests an existing workflow may be too complex or could be replaced with simpler OpenClaw-native primitives.",
    sourceKind: "workflow",
    evidenceLabel: "Workflow simplification signals",
    pattern:
      /\b(simplify|simpler|workflow|script instead|cron instead|skill instead|manual process|too many steps|reduce steps)\b/,
    minimumMatches: 2,
    recommendedAction:
      "Have the Program Manager compare the current path to simpler native primitives and sequence a proposal only if it reduces risk or effort.",
    requiredEvidence: safetyEvidence("workflow_simplification"),
    effort: "medium",
    confidence: 0.55,
  },
  {
    category: "agent_minimization",
    severity: "medium",
    title: "Agent minimization opportunity needs owner review",
    summary:
      "Recent task evidence points to agent sprawl or an opportunity to replace agent behavior with a skill, cron job, tool, or deterministic workflow.",
    sourceKind: "agent",
    evidenceLabel: "Agent minimization signals",
    pattern:
      /\b(agentless|without creating agents|replace agent|too many agents|agent sprawl|agent minimization|skill instead|cron instead)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have the Program Manager decide whether this should stay as an agent, become a skill/tool/workflow, or be retired, with explicit approval before structural changes.",
    requiredEvidence: safetyEvidence("agent_minimization"),
    effort: "large",
    confidence: 0.6,
  },
  {
    category: "capability_evolution",
    severity: "medium",
    title: "Capability evolution signal needs major-option review",
    summary:
      "Recent evidence suggests a new OpenClaw-native capability or platform primitive may replace a heavier implementation path.",
    sourceKind: "workflow",
    evidenceLabel: "Capability evolution signals",
    pattern:
      /\b(new primitive|new capability|native primitive|obsolete|migration|replace old pattern|platform primitive|new way of doing things)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have the Program Manager create a major-option recommendation with tradeoffs, blast radius, migration path, and verification gates.",
    requiredEvidence: safetyEvidence("capability_evolution"),
    impact: "high",
    effort: "large",
    confidence: 0.55,
  },
  {
    category: "knowledge_hygiene",
    severity: "medium",
    title: "Knowledge hygiene gap needs curator review",
    summary:
      "Recent evidence mentions stale, conflicting, or outdated docs, memory, or skills. The governor routes this through curation instead of writing memory directly.",
    sourceKind: "knowledge",
    evidenceLabel: "Knowledge hygiene signals",
    pattern:
      /\b(stale doc|stale skill|outdated|conflicting instruction|memory|knowledge|docs drift|old instruction)\b/,
    minimumMatches: 2,
    recommendedAction:
      "Have the Memory/Knowledge Curator review the stale source and create a pending update only when the replacement is specific and verified.",
    requiredEvidence: safetyEvidence("knowledge_hygiene"),
    effort: "small",
    confidence: 0.55,
  },
  {
    category: "architecture_simplification",
    severity: "medium",
    title: "Architecture simplification opportunity needs implementation proposal",
    summary:
      "Recent evidence mentions duplication, broad loaders, hot-path rediscovery, or unnecessary complexity that may be slowing OpenClaw down.",
    sourceKind: "architecture",
    evidenceLabel: "Architecture simplification signals",
    pattern:
      /\b(complex|refactor|duplicate path|broad loader|hot path|rediscovery|simplify architecture|shared seam|request-time discovery)\b/,
    minimumMatches: 2,
    recommendedAction:
      "Have the Builder Agent propose a narrow simplification with before/after behavior, compatibility notes, and targeted regression tests.",
    requiredEvidence: safetyEvidence("architecture_simplification"),
    impact: "high",
    effort: "large",
    confidence: 0.55,
  },
  {
    category: "risk_prevention",
    severity: "high",
    title: "Risk-prevention gap needs QA guardrails",
    summary:
      "Recent evidence mentions missing tests, secret exposure, destructive actions, approval gaps, or rollback concerns.",
    sourceKind: "risk",
    evidenceLabel: "Risk prevention signals",
    pattern:
      /\b(missing test|missing smoke|secret|destructive|approval|rollback|guardrail|unsafe|uncontrolled|no verification)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have the QA Test Agent identify the missing guardrail and add proof requirements before any risky code/config change proceeds.",
    requiredEvidence: safetyEvidence("risk_prevention"),
    impact: "high",
    effort: "medium",
    confidence: 0.65,
  },
  {
    category: "outcome_measurement",
    severity: "medium",
    title: "Outcome measurement gap needs a daily improvement metric",
    summary:
      "Recent evidence mentions metrics, baselines, scorecards, or trends without a clear improvement measurement loop.",
    sourceKind: "outcome",
    evidenceLabel: "Outcome measurement signals",
    pattern:
      /\b(metric|scorecard|baseline|success rate|measure|trend|what improved|what worsened|day over day|daily improvement)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have Todd Stanski define the user-facing improvement metric and the Program Manager sequence the smallest instrumentation needed.",
    requiredEvidence: safetyEvidence("outcome_measurement"),
    impact: "high",
    effort: "small",
    confidence: 0.6,
  },
  {
    category: "major_change",
    severity: "high",
    title: "Major change signal needs explicit option framing",
    summary:
      "Recent evidence suggests a large change to how OpenClaw works. The governor should frame the option and gates, not mutate production behavior.",
    sourceKind: "workflow",
    evidenceLabel: "Major change signals",
    pattern:
      /\b(major change|replace runtime|replace gateway|replace agent framework|new architecture|large migration|platform shift)\b/,
    minimumMatches: 1,
    recommendedAction:
      "Have the Program Manager create a major-change proposal with options, risks, migration stages, rollback plan, and required live verification.",
    requiredEvidence: safetyEvidence("major_change"),
    impact: "high",
    effort: "large",
    confidence: 0.55,
  },
];

function auditContinuousImprovementThemes(
  tasks: TaskRecord[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft[] {
  const drafts: RecommendationDraft[] = [];
  for (const theme of CONTINUOUS_IMPROVEMENT_THEMES) {
    const matchingTasks = tasks.filter((task) => theme.pattern.test(taskText(task)));
    if (matchingTasks.length < theme.minimumMatches) {
      continue;
    }
    drafts.push({
      category: theme.category,
      severity: theme.severity,
      priority: theme.severity,
      impact: theme.impact,
      effort: theme.effort,
      title: theme.title,
      groupTitle: theme.title,
      summary: theme.summary,
      source: {
        kind: theme.sourceKind,
        label: theme.evidenceLabel,
      },
      route: resolveSelfImprovementRoute({ cfg: params.cfg, category: theme.category }),
      recommendedAction: theme.recommendedAction,
      requiredEvidence: theme.requiredEvidence,
      evidence: matchingTasks
        .slice(0, 6)
        .map((task) => `${task.taskId}: ${taskTitle(task)} (${task.status})`),
      confidence: theme.confidence,
    });
  }
  return drafts;
}

function normalizeWorkflowFamily(task: TaskRecord): string {
  return sanitizeRecommendationText(
    [task.taskKind, task.label, task.task]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/\bsir_[a-f0-9]+\b/g, "sir")
      .replace(/\btask[-_:][a-z0-9-]+\b/g, "task")
      .replace(/\brun[-_:][a-z0-9-]+\b/g, "run")
      .replace(/\b\d{8}t\d{6}z[-_:]\d+\b/g, "snapshot")
      .replace(/\b[0-9a-f]{8,}\b/g, "id")
      .replace(/\d+/g, "n")
      .replace(/\s+/g, " ")
      .trim(),
    160,
  );
}

function taskDurationMs(task: TaskRecord): number {
  if (task.startedAt === undefined || task.endedAt === undefined) {
    return 0;
  }
  return Math.max(0, task.endedAt - task.startedAt);
}

function looksLikeVerificationWorkflow(task: TaskRecord): boolean {
  return /\b(pnpm test|pnpm build|ui:build|smoke|gateway status|verification|verify|test wrapper)\b/.test(
    taskText(task),
  );
}

function auditRepeatedWorkflowFamilies(
  tasks: TaskRecord[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft[] {
  const byFamily = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const family = normalizeWorkflowFamily(task);
    if (!family) {
      continue;
    }
    const interesting =
      task.status === "failed" ||
      task.status === "timed_out" ||
      task.status === "lost" ||
      task.terminalOutcome === "blocked" ||
      taskDurationMs(task) >= 30 * 60_000 ||
      looksLikeVerificationWorkflow(task);
    if (interesting) {
      byFamily.set(family, [...(byFamily.get(family) ?? []), task]);
    }
  }
  const drafts: RecommendationDraft[] = [];
  for (const [family, familyTasks] of byFamily) {
    const failedOrBlocked = familyTasks.filter(
      (task) =>
        task.status === "failed" ||
        task.status === "timed_out" ||
        task.status === "lost" ||
        task.terminalOutcome === "blocked",
    );
    const slow = familyTasks.filter((task) => taskDurationMs(task) >= 30 * 60_000);
    const verification = familyTasks.filter(looksLikeVerificationWorkflow);
    if (failedOrBlocked.length >= 2 || slow.length >= 2) {
      drafts.push({
        category: "efficiency_opportunity",
        severity: failedOrBlocked.some((task) => task.status === "timed_out") ? "high" : "medium",
        impact: "high",
        effort: "medium",
        title: `Repeated slow or blocked workflow needs efficiency review: ${family}`,
        summary:
          "The same workflow family repeatedly failed, blocked, timed out, or ran long. The governor recommends a bounded efficiency review instead of changing runtime behavior directly.",
        source: {
          kind: "workflow",
          label: `Repeated workflow family: ${family}`,
        },
        route: resolveSelfImprovementRoute({
          cfg: params.cfg,
          category: "efficiency_opportunity",
        }),
        recommendedAction:
          "Have the Builder Agent inspect the repeated workflow family, propose the smallest measurable improvement, and require before/after timing or reliability proof.",
        requiredEvidence: safetyEvidence("efficiency_opportunity"),
        evidence: [
          `Workflow family: ${family}`,
          `Failed/blocked/timed out: ${failedOrBlocked.length}`,
          `Slow runs: ${slow.length}`,
          ...familyTasks
            .slice(0, 6)
            .map((task) => `${task.taskId}: ${taskTitle(task)} (${task.status})`),
        ],
        confidence: Math.min(0.85, 0.58 + failedOrBlocked.length * 0.08 + slow.length * 0.05),
      });
    }
    if (verification.length >= 2) {
      drafts.push({
        category: "workflow_simplification",
        severity: verification.length >= 4 ? "high" : "medium",
        impact: verification.length >= 4 ? "high" : "medium",
        effort: "medium",
        title: `Repeated verification workflow can be simplified: ${family}`,
        summary:
          "Similar verification work is recurring. The governor recommends consolidating it through existing OpenClaw wrappers or a bounded workflow only if parity can be proven.",
        source: {
          kind: "workflow",
          label: `Repeated verification workflow: ${family}`,
        },
        route: resolveSelfImprovementRoute({
          cfg: params.cfg,
          category: "workflow_simplification",
        }),
        recommendedAction:
          "Have the Program Manager sequence a simplification proposal that preserves the current test wrappers and proves equivalent verification coverage.",
        requiredEvidence: safetyEvidence("workflow_simplification"),
        evidence: [
          `Workflow family: ${family}`,
          `Verification occurrences: ${verification.length}`,
          ...verification
            .slice(0, 6)
            .map((task) => `${task.taskId}: ${taskTitle(task)} (${task.status})`),
        ],
        confidence: Math.min(0.82, 0.56 + verification.length * 0.06),
      });
    }
  }
  return drafts;
}

function auditContinuousImprovementAuditEvents(
  events: SelfImprovementAuditEvent[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft[] {
  const eventText = (event: SelfImprovementAuditEvent): string =>
    [
      event.kind,
      event.summary,
      ...Object.entries(event.metadata ?? {}).flatMap(([key, value]) =>
        Array.isArray(value) ? [key, ...value] : [key, String(value)],
      ),
    ]
      .join(" ")
      .toLowerCase();
  const drafts: RecommendationDraft[] = [];
  for (const theme of CONTINUOUS_IMPROVEMENT_THEMES) {
    const matchingEvents = events.filter((event) => theme.pattern.test(eventText(event)));
    if (matchingEvents.length < theme.minimumMatches) {
      continue;
    }
    drafts.push({
      category: theme.category,
      severity: theme.severity,
      priority: theme.severity,
      impact: theme.impact,
      effort: theme.effort,
      title: `${theme.title} from audit ledger`,
      groupTitle: theme.title,
      summary:
        "Self-improvement audit events show a recurring continuous-improvement signal. The governor routes it for review and keeps the follow-up recommendation-only.",
      source: {
        kind: theme.sourceKind,
        label: `${theme.evidenceLabel} from audit ledger`,
      },
      route: resolveSelfImprovementRoute({ cfg: params.cfg, category: theme.category }),
      recommendedAction: theme.recommendedAction,
      requiredEvidence: theme.requiredEvidence,
      evidence: matchingEvents
        .slice(0, 6)
        .map((event) => `${event.id}: ${event.summary} (${event.kind})`),
      confidence: Math.min(0.8, (theme.confidence ?? 0.55) + matchingEvents.length * 0.04),
    });
  }
  return drafts;
}

function auditCronJob(
  job: CronJob,
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft | null {
  const state = job.state ?? {};
  const status = state.lastRunStatus ?? state.lastStatus;
  const consecutiveErrors =
    typeof state.consecutiveErrors === "number" && Number.isFinite(state.consecutiveErrors)
      ? Math.max(0, Math.floor(state.consecutiveErrors))
      : 0;
  if (
    status !== "error" &&
    consecutiveErrors <= 0 &&
    state.lastDeliveryStatus !== "not-delivered"
  ) {
    return null;
  }
  const isSmoke = /\b(dashboard|control[-\s]?ui|mobile|android|ios|smoke)\b/i.test(
    `${job.name} ${job.description ?? ""} ${state.lastError ?? ""}`,
  );
  const category: SelfImprovementRecommendationCategory = isSmoke
    ? "smoke_failure"
    : "task_reliability";
  return {
    category,
    severity: consecutiveErrors >= 3 || isSmoke ? "high" : "medium",
    title: isSmoke
      ? `Failed scheduled smoke needs QA review: ${job.name}`
      : `Scheduled job failure needs reliability review: ${job.name}`,
    summary:
      "A cron/background job has a failed execution or delivery state. The governor records a recommendation and leaves job mutation to explicit approval.",
    source: {
      kind: "cron_job",
      label: job.name,
      cronJobId: job.id,
      ...(job.agentId ? { agentId: job.agentId } : {}),
      ...(job.sessionKey ? { sessionKey: job.sessionKey } : {}),
    },
    route: resolveSelfImprovementRoute({ cfg: params.cfg, category }),
    recommendedAction:
      category === "smoke_failure"
        ? "Have the QA Test Agent rerun the smoke, collect failure proof, and propose the smallest verification or implementation fix."
        : "Inspect the cron run diagnostics and propose a safe retry/fix path with targeted verification.",
    requiredEvidence: safetyEvidence(category),
    evidence: sanitizeRecommendationTexts(
      [
        `Cron job ${job.id} status: ${status ?? "unknown"}`,
        `Consecutive errors: ${consecutiveErrors}`,
        state.lastError,
        state.lastDiagnosticSummary,
        state.lastDeliveryError,
      ],
      300,
    ),
  };
}

function auditSkillWorkshopProposal(
  proposal: SkillWorkshopProposalSnapshot,
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft | null {
  if (proposal.status === "quarantined") {
    return {
      category: "skill_workshop",
      severity: "high",
      title: `Quarantined Skill Workshop proposal needs curator review: ${proposal.title}`,
      summary:
        "A procedural-memory proposal is quarantined. The governor keeps it in review-only mode and routes it to memory curation.",
      source: {
        kind: "skill_workshop",
        label: proposal.title,
        proposalId: proposal.id,
        ...(proposal.agentId ? { agentId: proposal.agentId } : {}),
        ...(proposal.sessionId ? { sessionKey: proposal.sessionId } : {}),
      },
      route: resolveSelfImprovementRoute({ cfg: params.cfg, category: "skill_workshop" }),
      recommendedAction:
        "Have the Memory/Knowledge Curator inspect the quarantine reason and decide whether to reject, revise, or keep the proposal pending.",
      requiredEvidence: safetyEvidence("skill_workshop"),
      evidence: sanitizeRecommendationTexts(
        [proposal.reason, proposal.quarantineReason, proposal.skillName, proposal.workspaceDir],
        300,
      ),
    };
  }
  const age = params.now - (proposal.updatedAt ?? proposal.createdAt ?? params.now);
  if (proposal.status !== "pending" || age <= SKILL_WORKSHOP_PENDING_STALE_MS) {
    return null;
  }
  return {
    category: "skill_workshop",
    severity: "medium",
    title: `Pending Skill Workshop proposal is stale: ${proposal.title}`,
    summary:
      "A procedural-memory proposal has remained pending long enough to deserve curator attention.",
    source: {
      kind: "skill_workshop",
      label: proposal.title,
      proposalId: proposal.id,
      ...(proposal.agentId ? { agentId: proposal.agentId } : {}),
      ...(proposal.sessionId ? { sessionKey: proposal.sessionId } : {}),
    },
    route: resolveSelfImprovementRoute({ cfg: params.cfg, category: "skill_workshop" }),
    recommendedAction:
      "Review the proposal in Skill Workshop pending mode; do not write skills directly from the governor.",
    requiredEvidence: safetyEvidence("skill_workshop"),
    evidence: sanitizeRecommendationTexts(
      [
        `Pending age: ${Math.round(age / 60_000)} minutes`,
        proposal.reason,
        proposal.skillName,
        proposal.workspaceDir,
      ],
      300,
    ),
  };
}

function auditSkillWorkshopQueue(
  proposals: SkillWorkshopProposalSnapshot[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft | null {
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  if (pending.length < 5) {
    return null;
  }
  return {
    category: "skill_workshop",
    severity: "medium",
    title: "Skill Workshop pending queue needs curation",
    summary:
      "The pending procedural-memory queue has accumulated enough proposals that review sequencing is now useful.",
    source: {
      kind: "skill_workshop_queue",
      label: "Skill Workshop pending queue",
    },
    route: resolveSelfImprovementRoute({ cfg: params.cfg, category: "skill_workshop" }),
    recommendedAction:
      "Have the Memory/Knowledge Curator batch-review pending proposals and keep all writes approval-gated.",
    requiredEvidence: safetyEvidence("skill_workshop"),
    evidence: [
      `Pending proposals: ${pending.length}`,
      ...pending.slice(0, 5).map((proposal) => `${proposal.id}: ${proposal.title}`),
    ],
  };
}

function auditMetadataString(event: SelfImprovementAuditEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function auditMetadataBoolean(event: SelfImprovementAuditEvent, key: string): boolean | undefined {
  const value = event.metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function auditMetadataNumber(event: SelfImprovementAuditEvent, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function auditMetadataStringArray(event: SelfImprovementAuditEvent, key: string): string[] {
  const value = event.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function auditSelfImprovementModelPreflightEvents(
  events: SelfImprovementAuditEvent[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft | null {
  const readinessEvents = events.filter((event) => {
    if (event.kind !== "model_preflight") {
      return false;
    }
    const reviewPolicy = auditMetadataString(event, "reviewPolicy");
    const readiness = auditMetadataString(event, "readiness");
    return reviewPolicy === "local_first" && (readiness === "degraded" || readiness === "blocked");
  });
  if (readinessEvents.length === 0) {
    return null;
  }
  const latest = readinessEvents.toSorted((left, right) => right.createdAt - left.createdAt)[0];
  if (!latest) {
    return null;
  }
  const readiness = auditMetadataString(latest, "readiness") ?? "blocked";
  const readyModelId = auditMetadataString(latest, "readyModelId");
  const readyTier = auditMetadataString(latest, "readyTier");
  const blockedPrimaryReason =
    auditMetadataString(latest, "blockedPrimaryReason") ??
    auditMetadataString(latest, "fallbackReason") ??
    "local model readiness degraded";
  const reviewModelId = auditMetadataString(latest, "reviewModelId");
  const fallbackModelId = auditMetadataString(latest, "fallbackModelId");
  const preflightStatus = auditMetadataString(latest, "preflightStatus");
  const primaryRemediationHint = auditMetadataString(latest, "primaryRemediationHint");
  const blockedRemediationHints = auditMetadataStringArray(latest, "blockedRemediationHints");
  const route = resolveSelfImprovementRoute({ cfg: params.cfg, category: "model_routing" });
  return {
    category: "model_routing",
    severity: readiness === "blocked" ? "high" : "medium",
    title: "Self-Improvement local model readiness needs inspection",
    summary:
      "The Governor audit ledger shows local-first model preflight is degraded or blocked. This should be fixed through local model serving, provider config, or fallback routing without enabling uncontrolled hosted review.",
    source: {
      kind: "configuration",
      label: "Self-Improvement model preflight audit events",
    },
    route,
    recommendedAction:
      "Have the Builder Agent inspect the local reviewer provider setup and propose the smallest safe change that makes the preferred local model ready while preserving deterministic fallback.",
    requiredEvidence: [
      "Run `openclaw self-improvement preflight --json` and attach readiness output.",
      "Run `openclaw self-improvement analyze --local-first --limit 1 --json` and attach schema status.",
      "Keep hosted escalation disabled unless explicit approval and env gates are present.",
    ],
    evidence: [
      `Latest readiness: ${readiness}`,
      `Blocked primary reason: ${blockedPrimaryReason}`,
      readyTier && readyModelId ? `Ready fallback: ${readyTier} ${readyModelId}` : "",
      reviewModelId ? `Primary review model: ${reviewModelId}` : "",
      fallbackModelId ? `Fallback model: ${fallbackModelId}` : "",
      preflightStatus ? `Preflight status: ${preflightStatus}` : "",
      primaryRemediationHint ? `Primary remediation hint: ${primaryRemediationHint}` : "",
      ...blockedRemediationHints.map((hint) => `Blocked attempt remediation: ${hint}`),
      ...readinessEvents.slice(0, 4).map((event) => `${event.id}: ${event.summary}`),
    ],
    confidence: readinessEvents.length > 1 ? 0.75 : 0.65,
  };
}

function auditSelfImprovementReviewEvents(
  events: SelfImprovementAuditEvent[],
  params: SelfImprovementAuditInput & { now: number },
): RecommendationDraft | null {
  const reviewEvents = events.filter((event) => {
    if (event.kind !== "analysis_run") {
      return false;
    }
    const reviewPolicy = auditMetadataString(event, "reviewPolicy");
    return reviewPolicy === "local_first" || reviewPolicy === "hosted";
  });
  const latestReviewEvent = reviewEvents.toSorted(
    (left, right) => right.createdAt - left.createdAt,
  )[0];
  if (
    latestReviewEvent &&
    auditMetadataString(latestReviewEvent, "mode") !== "fallback" &&
    auditMetadataBoolean(latestReviewEvent, "schemaValidated") === true
  ) {
    return null;
  }
  const fallbackEvents = reviewEvents.filter((event) => {
    const mode = auditMetadataString(event, "mode");
    const schemaValidated = auditMetadataBoolean(event, "schemaValidated");
    const fallbackReason = auditMetadataString(event, "fallbackReason");
    return mode === "fallback" && schemaValidated === false && Boolean(fallbackReason);
  });
  if (fallbackEvents.length === 0) {
    return null;
  }
  const latest = fallbackEvents.toSorted((left, right) => right.createdAt - left.createdAt)[0];
  if (!latest) {
    return null;
  }
  const fallbackReason = auditMetadataString(latest, "fallbackReason") ?? "model review fallback";
  const reviewPolicy = auditMetadataString(latest, "reviewPolicy") ?? "unknown";
  const modelId = auditMetadataString(latest, "modelId");
  const modelTier = auditMetadataString(latest, "modelTier");
  const attemptStatuses = auditMetadataStringArray(latest, "attemptStatuses");
  const attemptBlockers = auditMetadataStringArray(latest, "attemptBlockers");
  const blockedRemediationHints = auditMetadataStringArray(latest, "blockedRemediationHints");
  const invalidJsonDiagnostics = auditMetadataStringArray(latest, "invalidJsonDiagnostics");
  const invalidJsonAttempts = auditMetadataNumber(latest, "invalidJsonAttempts") ?? 0;
  const failedAttempts = auditMetadataNumber(latest, "failedAttempts") ?? 0;
  const route = resolveSelfImprovementRoute({ cfg: params.cfg, category: "model_routing" });
  return {
    category: "model_routing",
    severity:
      fallbackReason.toLowerCase().includes("invalid json") ||
      invalidJsonAttempts > 0 ||
      failedAttempts > 0
        ? "high"
        : "medium",
    title: "Self-Improvement model reviewer fallback needs inspection",
    summary:
      "The Governor audit ledger shows model review falling back to deterministic analysis. This should be fixed through model routing, schema, prompt, or serving changes rather than by storing uncontrolled model output.",
    source: {
      kind: "configuration",
      label: "Self-Improvement model review audit events",
    },
    route,
    recommendedAction:
      "Have the Builder Agent inspect the local reviewer serving config and JSON schema path, then propose the smallest change that produces schema-valid local review output while keeping deterministic fallback.",
    requiredEvidence: [
      "Run `openclaw self-improvement preflight --json` and attach readiness output.",
      "Run a local-first self-improvement analysis smoke and attach schema status.",
      "Keep hosted escalation disabled unless explicit approval and env gates are present.",
    ],
    evidence: [
      `Latest fallback reason: ${fallbackReason}`,
      `Review policy: ${reviewPolicy}`,
      modelTier ? `Model tier: ${modelTier}` : "",
      modelId ? `Model id: ${modelId}` : "",
      invalidJsonAttempts > 0 ? `Invalid JSON attempts: ${invalidJsonAttempts}` : "",
      ...invalidJsonDiagnostics.map((diagnostic) => `Invalid JSON diagnostic: ${diagnostic}`),
      failedAttempts > 0 ? `Failed attempts: ${failedAttempts}` : "",
      ...attemptStatuses.map((status) => `Attempt status: ${status}`),
      ...attemptBlockers.map((blocker) => `Attempt blocker: ${blocker}`),
      ...blockedRemediationHints.map((hint) => `Blocked attempt remediation: ${hint}`),
      ...fallbackEvents.slice(0, 4).map((event) => `${event.id}: ${event.summary}`),
    ],
    confidence: fallbackEvents.length > 1 ? 0.75 : 0.65,
  };
}

function dedupeRecommendations(
  recommendations: SelfImprovementRecommendation[],
): SelfImprovementRecommendation[] {
  const byFingerprint = new Map<string, SelfImprovementRecommendation>();
  for (const recommendation of recommendations) {
    const existing = byFingerprint.get(recommendation.fingerprint);
    if (!existing || SEVERITY_ORDER[recommendation.severity] > SEVERITY_ORDER[existing.severity]) {
      byFingerprint.set(recommendation.fingerprint, recommendation);
    }
  }
  return [...byFingerprint.values()].toSorted(
    (left, right) =>
      SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
      left.category.localeCompare(right.category) ||
      left.title.localeCompare(right.title),
  );
}

export async function auditSelfImprovementOpportunities(
  input: SelfImprovementAuditInput,
): Promise<SelfImprovementAuditResult> {
  const now = input.now ?? Date.now();
  const taskDrafts = input.tasks.flatMap((task) => auditTask(task, { ...input, now }));
  const correctionDrafts = auditRepeatedCorrections(input.tasks, { ...input, now });
  const continuousImprovementDrafts = auditContinuousImprovementThemes(input.tasks, {
    ...input,
    now,
  });
  const repeatedWorkflowDrafts = auditRepeatedWorkflowFamilies(input.tasks, {
    ...input,
    now,
  });
  const cronDrafts = (input.cronJobs ?? [])
    .map((job) => auditCronJob(job, { ...input, now }))
    .filter((draft): draft is RecommendationDraft => Boolean(draft));
  const skillWorkshopProposals =
    input.skillWorkshopProposals ??
    (await readSkillWorkshopProposalSnapshots({ stateDir: input.stateDir }));
  const skillWorkshopDrafts = [
    ...skillWorkshopProposals
      .map((proposal) => auditSkillWorkshopProposal(proposal, { ...input, now }))
      .filter((draft): draft is RecommendationDraft => Boolean(draft)),
    auditSkillWorkshopQueue(skillWorkshopProposals, { ...input, now }),
  ].filter((draft): draft is RecommendationDraft => Boolean(draft));
  const auditEvents =
    input.auditEvents ??
    (await listSelfImprovementAuditEvents({ stateDir: input.stateDir, limit: 100 }));
  const auditEventDrafts = [
    auditSelfImprovementModelPreflightEvents(auditEvents, { ...input, now }),
    auditSelfImprovementReviewEvents(auditEvents, { ...input, now }),
    ...auditContinuousImprovementAuditEvents(auditEvents, { ...input, now }),
  ].filter((draft): draft is RecommendationDraft => Boolean(draft));
  const recommendations = dedupeRecommendations(
    [
      ...taskDrafts,
      ...correctionDrafts,
      ...continuousImprovementDrafts,
      ...repeatedWorkflowDrafts,
      ...cronDrafts,
      ...skillWorkshopDrafts,
      ...auditEventDrafts,
    ]
      .filter((draft): draft is RecommendationDraft => Boolean(draft))
      .map((draft) => buildRecommendation(draft, now)),
  );
  return {
    recommendations,
    inspected: {
      tasks: input.tasks.length,
      cronJobs: input.cronJobs?.length ?? 0,
      auditEvents: auditEvents.length,
      skillWorkshopProposals: skillWorkshopProposals.length,
    },
  };
}
