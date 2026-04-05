import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  browserStatus,
  getBrowserControlState,
  resolveBrowserConfig,
  startBrowserControlServiceFromConfig,
} from "../../extensions/browser/runtime-api.js";
import { runEmbeddedPiAgent, type EmbeddedPiRunResult } from "../agents/pi-embedded.js";
import { ensureSessionHeader } from "../agents/pi-embedded-helpers.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveEffectiveToolPolicy } from "../agents/pi-tools.policy.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { getGatewayBroadcastRuntime } from "../gateway/server-broadcast-runtime.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildClawHelperExtraSystemPrompt,
  buildClawHelperPrompt,
  buildClawPlanningExtraSystemPrompt,
  buildClawPlanningPrompt,
  buildClawRunnerExtraSystemPrompt,
  buildClawRunnerPrompt,
  buildClawVerifierExtraSystemPrompt,
  buildClawVerifierPrompt,
} from "./prompts.js";
import type {
  ClawArtifactEntry,
  ClawAuditEntry,
  ClawControlState,
  ClawDecisionAction,
  ClawInboxItem,
  ClawManagedFlowStatus,
  ClawMissionDashboard,
  ClawMissionDetail,
  ClawMissionDetailSnapshot,
  ClawMissionFileEntry,
  ClawMissionStatus,
  ClawPendingDecision,
  ClawPreflightCheck,
} from "../shared/claw-types.js";
import {
  createManagedTaskFlow,
  failFlow,
  finishFlow,
  getTaskFlowById,
  resumeFlow,
  setFlowWaiting,
  updateFlowRecordByIdExpectedRevision,
} from "../tasks/task-flow-registry.js";

const log = createSubsystemLogger("claw/service");

const MISSIONS_DIRNAME = "missions";
const MISSION_STATE_FILENAME = "mission-state.json";
const MISSION_CONTROL_FILENAME = "control-state.json";
const MISSION_AUDIT_FILENAME = "AUDIT_LOG.jsonl";

type ClawMissionStateRecord = Omit<ClawMissionDetail, "requiresAttention"> & {
  version: 1;
  missionPlan: ClawMissionPlan;
  runnerSessionId: string | null;
  runnerSessionFile: string | null;
  recoveryTargetStatus: Extract<ClawMissionStatus, "running" | "verifying"> | null;
  recentEvidence: string[];
  consecutiveFailureCount: number;
  consecutiveNoProgressCount: number;
  consecutiveVerifierRejectCount: number;
  lastFailureSummary: string | null;
  lastVerifierRejectionSignature: string | null;
  runCycleCount: number;
  verifyCycleCount: number;
};

type ClawServiceDeps = {
  now?: () => Date;
  resolveWorkspaceDir?: () => string;
  loadConfig?: () => OpenClawConfig;
  runEmbeddedPiAgent?: typeof runEmbeddedPiAgent;
  inspectBrowserReadiness?: (cfg: OpenClawConfig) => Promise<ClawBrowserReadiness>;
};

const TERMINAL_MISSION_STATUSES = new Set<ClawMissionStatus>([
  "done",
  "failed",
  "cancelled",
]);

const ACTIVE_MISSION_STATUSES = new Set<ClawMissionStatus>([
  "queued",
  "running",
  "recovering",
  "verifying",
]);

const PAUSABLE_MISSION_STATUSES = new Set<ClawMissionStatus>([
  "queued",
  "running",
  "recovering",
  "verifying",
  "blocked",
]);

const CLAW_MAX_ACTIVE_MISSIONS = 1;
const CLAW_RUNNER_MAX_FAILURES = 3;
const CLAW_RUNNER_MAX_NO_PROGRESS = 3;
const CLAW_VERIFIER_MAX_REJECTIONS = 2;

function hasBlockingPreflight(checks: readonly ClawPreflightCheck[]): boolean {
  return checks.some(
    (check) => check.blocker || check.status === "blocked" || check.status === "needs_setup",
  );
}

function summarizeBlockingPreflight(checks: readonly ClawPreflightCheck[]): string | null {
  const blocking = checks.filter(
    (check) => check.blocker || check.status === "blocked" || check.status === "needs_setup",
  );
  if (blocking.length === 0) {
    return null;
  }
  return blocking.map((check) => check.summary).join(" ");
}

function isTerminalMissionStatus(status: ClawMissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.has(status);
}

function canPauseMissionStatus(status: ClawMissionStatus): boolean {
  return PAUSABLE_MISSION_STATUSES.has(status);
}

function shouldStartMissionImmediately(control: ClawControlState): boolean {
  return control.autonomyEnabled && !control.pauseAll && !control.stopAllNowRequestedAt;
}

function resolveQueuedCurrentStep(control: ClawControlState): string {
  if (control.stopAllNowRequestedAt) {
    return "Queued until the emergency stop is cleared.";
  }
  if (control.pauseAll) {
    return "Queued until the global pause is cleared.";
  }
  if (!control.autonomyEnabled) {
    return "Queued until autonomy is re-enabled.";
  }
  return "Queued for execution.";
}

function buildCycleRunId(kind: "runner" | "verifier" | "helper", missionId: string): string {
  return `claw-${kind}-${missionId}-${crypto.randomUUID().slice(0, 8)}`;
}

function joinPayloadText(result: EmbeddedPiRunResult): string {
  const text = (result.payloads ?? [])
    .map((payload) => payload.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return text.trim();
}

function normalizeEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeTextList(value: unknown, maxItems: number, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, maxItems);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeSummaryText(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized || fallback;
}

function compactGoal(goal: string, maxLength = 160): string {
  const normalized = goal.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], trimmed]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

type ClawRunnerDecision = {
  outcome: "continue" | "verify" | "blocked" | "failed";
  summary: string;
  currentStep: string;
  nextStep?: string | null;
  progress: boolean;
  blockerSummary?: string | null;
  blockerDetail?: string | null;
  evidence: string[];
};

type ClawVerifierDecision = {
  outcome: "done" | "reject" | "blocked";
  summary: string;
  nextStep?: string | null;
  unmetCriteria: string[];
  blockerSummary?: string | null;
  evidence: string[];
};

type ClawHelperDecision = {
  outcome: "continue" | "blocked";
  summary: string;
  nextStep?: string | null;
  blockerSummary?: string | null;
  evidence: string[];
};

type ClawMissionPlan = {
  source: "fallback" | "planned";
  summary: string;
  scopeIn: string[];
  scopeOut: string[];
  phases: string[];
  tasks: string[];
  doneCriteria: string[];
};

type ClawPlanningDecision = {
  summary: string;
  scopeIn: string[];
  scopeOut: string[];
  phases: string[];
  tasks: string[];
  doneCriteria: string[];
};

type ClawBrowserReadiness = {
  ready: boolean;
  summary: string;
  detail?: string | null;
};

function parseRunnerDecision(text: string): ClawRunnerDecision {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Runner did not return a valid JSON object.");
  }
  const outcome = parsed.outcome;
  if (
    outcome !== "continue" &&
    outcome !== "verify" &&
    outcome !== "blocked" &&
    outcome !== "failed"
  ) {
    throw new Error(`Runner returned an unsupported outcome: ${String(outcome)}`);
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const currentStep =
    typeof parsed.currentStep === "string" ? parsed.currentStep.trim() : summary || "";
  if (!summary || !currentStep) {
    throw new Error("Runner response must include summary and currentStep.");
  }
  return {
    outcome,
    summary,
    currentStep,
    nextStep: typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : null,
    progress: parsed.progress !== false,
    blockerSummary:
      typeof parsed.blockerSummary === "string" ? parsed.blockerSummary.trim() : null,
    blockerDetail: typeof parsed.blockerDetail === "string" ? parsed.blockerDetail.trim() : null,
    evidence: normalizeEvidence(parsed.evidence),
  };
}

function parseVerifierDecision(text: string): ClawVerifierDecision {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Verifier did not return a valid JSON object.");
  }
  const outcome = parsed.outcome;
  if (outcome !== "done" && outcome !== "reject" && outcome !== "blocked") {
    throw new Error(`Verifier returned an unsupported outcome: ${String(outcome)}`);
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) {
    throw new Error("Verifier response must include summary.");
  }
  return {
    outcome,
    summary,
    nextStep: typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : null,
    unmetCriteria: normalizeEvidence(parsed.unmetCriteria),
    blockerSummary:
      typeof parsed.blockerSummary === "string" ? parsed.blockerSummary.trim() : null,
    evidence: normalizeEvidence(parsed.evidence),
  };
}

function parseHelperDecision(text: string): ClawHelperDecision {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Helper did not return a valid JSON object.");
  }
  const outcome = parsed.outcome;
  if (outcome !== "continue" && outcome !== "blocked") {
    throw new Error(`Helper returned an unsupported outcome: ${String(outcome)}`);
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) {
    throw new Error("Helper response must include summary.");
  }
  return {
    outcome,
    summary,
    nextStep: typeof parsed.nextStep === "string" ? parsed.nextStep.trim() : null,
    blockerSummary:
      typeof parsed.blockerSummary === "string" ? parsed.blockerSummary.trim() : null,
    evidence: normalizeEvidence(parsed.evidence),
  };
}

function buildFallbackMissionPlan(params: {
  title: string;
  goal: string;
}): ClawMissionPlan {
  const goalSummary = compactGoal(params.goal);
  return {
    source: "fallback",
    summary: `Drive the current repository and runtime toward this goal: ${goalSummary}`,
    scopeIn: [
      `Deliver the approved outcome for "${params.title}".`,
      "Work inside the current repository and runtime only where it directly moves the mission forward.",
      "Keep mission files, evidence, and audit history aligned with durable progress.",
    ],
    scopeOut: [
      "Unrelated cleanup or refactors that do not materially advance the approved goal.",
      "New product directions or side quests that are not implied by the approved mission.",
    ],
    phases: [
      `Inspect the current repository/runtime state for "${params.title}".`,
      `Execute the concrete code, config, or runtime changes needed to satisfy: ${goalSummary}`,
      "Verify the result against explicit done criteria before marking the mission done.",
    ],
    tasks: [
      `Inspect the repo/runtime surfaces most relevant to: ${goalSummary}`,
      `Implement the primary work required to satisfy "${params.title}".`,
      "Record durable evidence and keep the mission packet current after meaningful progress.",
      "Pass the required fresh-context verifier before completing the mission.",
    ],
    doneCriteria: [
      `The approved goal is satisfied: ${goalSummary}`,
      "The mission packet reflects the final repository/runtime state and captured evidence.",
      "A fresh verifier confirms the explicit done criteria are satisfied.",
    ],
  };
}

function parsePlanningDecision(
  text: string,
  fallback: ClawMissionPlan,
): ClawPlanningDecision {
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("Planning pass did not return a valid JSON object.");
  }

  const summary = normalizeSummaryText(parsed.summary, fallback.summary);
  return {
    summary,
    scopeIn: normalizeTextList(parsed.scopeIn, 6, fallback.scopeIn),
    scopeOut: normalizeTextList(parsed.scopeOut, 6, fallback.scopeOut),
    phases: normalizeTextList(parsed.phases, 8, fallback.phases),
    tasks: normalizeTextList(parsed.tasks, 10, fallback.tasks),
    doneCriteria: normalizeTextList(parsed.doneCriteria, 8, fallback.doneCriteria),
  };
}

function isActionableDecisionForMission(
  mission: Pick<ClawMissionStateRecord, "status">,
  decision: ClawPendingDecision,
): boolean {
  if (decision.status !== "pending") {
    return false;
  }
  if (decision.kind === "start_approval") {
    return mission.status === "awaiting_approval";
  }
  if (decision.kind === "preflight_blocker") {
    return mission.status === "awaiting_setup";
  }
  if (decision.kind === "recovery_uncertain") {
    return mission.status === "recovering" || mission.status === "blocked";
  }
  return true;
}

function defaultResolveWorkspaceDir(): string {
  const cfg = loadConfig();
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function normalizeTitle(title: string): string {
  const compact = title.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77).trimEnd()}...` : compact;
}

function deriveMissionTitle(goal: string): string {
  const firstLine = goal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return "Untitled mission";
  }
  return normalizeTitle(firstLine.replace(/^[-*#>\d.\s]+/, ""));
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "mission";
}

function buildMissionId(now: Date, title: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${slugify(title)}-${crypto.randomUUID().slice(0, 8)}`;
}

function requiresAttention(state: Pick<ClawMissionStateRecord, "status" | "decisions">): boolean {
  if (state.decisions.some((decision) => decision.status === "pending")) {
    return true;
  }
  return (
    state.status === "awaiting_setup" ||
    state.status === "awaiting_approval" ||
    state.status === "blocked" ||
    state.status === "paused" ||
    state.status === "failed"
  );
}

function missionFilesForState(state: ClawMissionStateRecord): ClawMissionFileEntry[] {
  return [
    { name: "MISSION.md", path: path.join(state.missionDir, "MISSION.md"), kind: "markdown" },
    {
      name: "PROJECT_SCOPE.md",
      path: path.join(state.missionDir, "PROJECT_SCOPE.md"),
      kind: "markdown",
    },
    {
      name: "PROJECT_PLAN.md",
      path: path.join(state.missionDir, "PROJECT_PLAN.md"),
      kind: "markdown",
    },
    {
      name: "PROJECT_TASKS.md",
      path: path.join(state.missionDir, "PROJECT_TASKS.md"),
      kind: "markdown",
    },
    {
      name: "PROJECT_STATUS.md",
      path: path.join(state.missionDir, "PROJECT_STATUS.md"),
      kind: "markdown",
    },
    {
      name: "PROJECT_DONE_CRITERIA.md",
      path: path.join(state.missionDir, "PROJECT_DONE_CRITERIA.md"),
      kind: "markdown",
    },
    {
      name: "PRECHECKS.md",
      path: path.join(state.missionDir, "PRECHECKS.md"),
      kind: "markdown",
    },
    {
      name: "BLOCKERS.md",
      path: path.join(state.missionDir, "BLOCKERS.md"),
      kind: "markdown",
    },
    {
      name: "DECISIONS.md",
      path: path.join(state.missionDir, "DECISIONS.md"),
      kind: "markdown",
    },
    {
      name: "ARTIFACTS.md",
      path: path.join(state.missionDir, "ARTIFACTS.md"),
      kind: "markdown",
    },
    {
      name: MISSION_STATE_FILENAME,
      path: path.join(state.missionDir, MISSION_STATE_FILENAME),
      kind: "state",
    },
    {
      name: MISSION_AUDIT_FILENAME,
      path: state.auditLogPath,
      kind: "audit",
    },
    {
      name: "artifacts/",
      path: state.artifactsDir,
      kind: "directory",
    },
    {
      name: "logs/",
      path: state.logsDir,
      kind: "directory",
    },
  ];
}

async function canReadWritePath(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasConfiguredDefaultModel(cfg: OpenClawConfig): boolean {
  const model = cfg.agents?.defaults?.model;
  if (typeof model === "string") {
    return model.trim().length > 0;
  }
  return Boolean(model);
}

function isBrowserPluginEnabled(cfg: OpenClawConfig): boolean {
  return cfg.plugins?.entries?.browser?.enabled === true;
}

type ClawMissionCapabilityNeeds = {
  browserRequired: boolean;
  helperSessionsUseful: boolean;
  gatewayRequired: boolean;
  manualAuthRequired: boolean;
  likelyAuthDomains: string[];
  likelyExternalSystems: string[];
  schedulingLikely: boolean;
};

function goalMentionsAny(goal: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(goal));
}

function inferMissionCapabilityNeeds(goal: string): ClawMissionCapabilityNeeds {
  const normalizedGoal = goal.trim().toLowerCase();
  const browserRequired = goalMentionsAny(normalizedGoal, [
    /\bbrowser\b/,
    /\bchrome\b/,
    /\bwebsite\b/,
    /\bweb app\b/,
    /\bwebpage\b/,
    /\blogin\b/,
    /\bsign in\b/,
    /\bcaptcha\b/,
    /\bmfa\b/,
    /\b2fa\b/,
    /\boauth\b/,
    /\btab\b/,
    /\bpage\b/,
    /\bgmail\b/,
  ]);
  const manualAuthRequired = goalMentionsAny(normalizedGoal, [
    /\blogin\b/,
    /\bsign in\b/,
    /\bcaptcha\b/,
    /\bmfa\b/,
    /\b2fa\b/,
    /\botp\b/,
    /\boauth\b/,
    /\bmanual auth\b/,
  ]);
  const helperSessionsUseful = goalMentionsAny(normalizedGoal, [
    /\bresearch\b/,
    /\binvestigat/,
    /\bcompare\b/,
    /\banalyz/,
    /\breplan\b/,
  ]);
  const schedulingLikely = goalMentionsAny(normalizedGoal, [
    /\bschedule\b/,
    /\brecurring\b/,
    /\bremind\b/,
    /\bfollow up\b/,
    /\blater\b/,
    /\btomorrow\b/,
  ]);
  const gatewayRequired = goalMentionsAny(normalizedGoal, [
    /\bgateway\b/,
    /\bdaemon\b/,
    /\brestart\b/,
    /\bnode\b/,
    /\bcontrol plane\b/,
  ]);

  const likelyAuthDomains = new Set<string>();
  const likelyExternalSystems = new Set<string>();
  const providers: Array<{ key: string; pattern: RegExp }> = [
    { key: "GitHub", pattern: /\bgithub\b|\bpull request\b|\bpr\b|\bbranch\b|\bcommit\b|\bpush\b/ },
    { key: "AWS", pattern: /\baws\b|\bec2\b|\bs3\b|\blambda\b/ },
    { key: "Cloudflare", pattern: /\bcloudflare\b|\bworkers\b/ },
    { key: "Vercel", pattern: /\bvercel\b/ },
    { key: "Render", pattern: /\brender\b/ },
    { key: "Netlify", pattern: /\bnetlify\b/ },
    { key: "Stripe", pattern: /\bstripe\b/ },
    { key: "Supabase", pattern: /\bsupabase\b/ },
  ];
  for (const provider of providers) {
    if (provider.pattern.test(normalizedGoal)) {
      likelyExternalSystems.add(provider.key);
      likelyAuthDomains.add(provider.key);
    }
  }
  if (browserRequired || manualAuthRequired) {
    likelyExternalSystems.add("browser");
  }
  if (manualAuthRequired) {
    likelyAuthDomains.add("interactive browser session");
  }

  return {
    browserRequired,
    helperSessionsUseful,
    gatewayRequired,
    manualAuthRequired,
    likelyAuthDomains: [...likelyAuthDomains],
    likelyExternalSystems: [...likelyExternalSystems],
    schedulingLikely,
  };
}

function isToolExposedForMission(cfg: OpenClawConfig, toolName: string): boolean {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const policy = resolveEffectiveToolPolicy({
    config: cfg,
    agentId: defaultAgentId,
  });
  return isToolAllowedByPolicies(toolName, [
    policy.globalPolicy,
    policy.globalProviderPolicy,
    policy.agentPolicy,
    policy.agentProviderPolicy,
  ]);
}

async function defaultInspectBrowserReadiness(
  cfg: OpenClawConfig,
): Promise<ClawBrowserReadiness> {
  if (!isBrowserPluginEnabled(cfg)) {
    return {
      ready: false,
      summary: "The browser plugin is not enabled.",
    };
  }

  let resolvedBrowser: ReturnType<typeof resolveBrowserConfig>;
  try {
    resolvedBrowser = resolveBrowserConfig(cfg.browser, cfg);
  } catch (error) {
    return {
      ready: false,
      summary: "Browser configuration is invalid.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!resolvedBrowser.enabled) {
    return {
      ready: false,
      summary: "Browser control is disabled in config.",
    };
  }

  try {
    const control = getBrowserControlState() ?? (await startBrowserControlServiceFromConfig());
    if (!control) {
      return {
        ready: false,
        summary: "Browser control service could not be started from config.",
      };
    }

    const status = await browserStatus(`http://127.0.0.1:${control.port}`);
    if (!status.enabled) {
      return {
        ready: false,
        summary: "Browser control reported a disabled status.",
      };
    }
    if (typeof status.detectError === "string" && status.detectError.trim()) {
      return {
        ready: false,
        summary: "Browser control could not resolve a runnable browser.",
        detail: status.detectError.trim(),
      };
    }
    if (status.running && status.cdpReady !== false) {
      return {
        ready: true,
        summary: "Browser control is ready and the configured profile is already running.",
      };
    }
    if (status.attachOnly) {
      return {
        ready: true,
        summary: "Browser control is ready in attach-only mode and can attach to an existing session.",
      };
    }
    const chosenBrowser =
      status.detectedExecutablePath ??
      status.executablePath ??
      status.chosenBrowser ??
      status.detectedBrowser;
    return {
      ready: true,
      summary: chosenBrowser
        ? `Browser control is ready and can start ${chosenBrowser} on demand.`
        : "Browser control is ready for browser-dependent mission work.",
    };
  } catch (error) {
    return {
      ready: false,
      summary: "Browser control did not report a ready state.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildPreflightChecks(params: {
  goal: string;
  workspaceDir: string;
  missionDir: string;
  cfg: OpenClawConfig;
  inspectBrowserReadiness: (cfg: OpenClawConfig) => Promise<ClawBrowserReadiness>;
}): Promise<ClawPreflightCheck[]> {
  const capabilityNeeds = inferMissionCapabilityNeeds(params.goal);
  let browserConfigured = false;
  let browserConfigDetail: string | null = null;
  try {
    browserConfigured = resolveBrowserConfig(params.cfg.browser, params.cfg).enabled;
  } catch (error) {
    browserConfigDetail = error instanceof Error ? error.message : String(error);
  }
  const [workspaceReady, missionDirReady] = await Promise.all([
    canReadWritePath(params.workspaceDir),
    canReadWritePath(params.missionDir),
  ]);
  const defaultModelReady = hasConfiguredDefaultModel(params.cfg);
  const execToolReady = isToolExposedForMission(params.cfg, "exec");
  const processToolReady = isToolExposedForMission(params.cfg, "process");
  const browserToolReady = isToolExposedForMission(params.cfg, "browser");
  const gatewayToolReady = isToolExposedForMission(params.cfg, "gateway");
  const cronToolReady = isToolExposedForMission(params.cfg, "cron");
  const helperToolsReady =
    isToolExposedForMission(params.cfg, "sessions_spawn") &&
    isToolExposedForMission(params.cfg, "subagents");
  const browserPluginReady = isBrowserPluginEnabled(params.cfg);
  const gatewayRuntimeReady = getGatewayBroadcastRuntime() != null;
  const browserReadiness =
    capabilityNeeds.browserRequired && browserToolReady && browserPluginReady && browserConfigured
      ? await params.inspectBrowserReadiness(params.cfg)
      : null;
  const browserReady =
    browserToolReady &&
    browserPluginReady &&
    browserConfigured &&
    (!capabilityNeeds.browserRequired || browserReadiness?.ready === true);
  const browserSummary = capabilityNeeds.browserRequired
    ? browserReady
      ? browserReadiness?.summary ?? "Browser automation is available for this mission."
      : !browserPluginReady
        ? "This goal appears to require browser work, but the browser plugin is not enabled."
        : !browserToolReady
          ? "This goal appears to require browser work, but the browser tool is blocked by current tool policy."
          : !browserConfigured
            ? "This goal appears to require browser work, but browser control is disabled or invalid in config."
            : browserReadiness?.summary ?? "This goal appears to require browser work, but the browser runtime is not ready."
    : browserToolReady && browserPluginReady && browserConfigured
      ? "Browser automation is configured and can be used later if the mission needs it."
      : "Browser automation is optional for this mission.";
  const browserDetail =
    browserReadiness?.detail ??
    (browserConfigDetail
      ? `Browser configuration error: ${browserConfigDetail}`
      : capabilityNeeds.browserRequired && !browserConfigured
        ? "Enable a browser control profile in config before approving this mission."
        : null);

  return [
    {
      id: "workspace-root",
      category: "workspace",
      title: "Workspace root resolved",
      status: workspaceReady ? "ready" : "blocked",
      summary: workspaceReady
        ? `Mission files will be stored under ${params.workspaceDir}.`
        : `OpenClaw cannot read and write ${params.workspaceDir}.`,
      blocker: !workspaceReady,
    },
    {
      id: "mission-folder",
      category: "workspace",
      title: "Mission folder initialized",
      status: missionDirReady ? "ready" : "blocked",
      summary: missionDirReady
        ? `Mission packet will live in ${params.missionDir}.`
        : `OpenClaw cannot read and write ${params.missionDir}.`,
      blocker: !missionDirReady,
    },
    {
      id: "default-model",
      category: "runtime",
      title: "Default model available",
      status: defaultModelReady ? "ready" : "needs_setup",
      summary: defaultModelReady
        ? "A default agent model is configured for mission execution."
        : "Configure agents.defaults.model before starting a mission.",
      blocker: !defaultModelReady,
    },
    {
      id: "task-flow-runtime",
      category: "runtime",
      title: "Task Flow mirror ready",
      status: "ready",
      summary: "Mission state is mirrored through the managed Task Flow registry for restart safety.",
    },
    {
      id: "gateway-runtime",
      category: "runtime",
      title: "Gateway runtime ready",
      status: gatewayRuntimeReady
        ? "ready"
        : capabilityNeeds.gatewayRequired
          ? "needs_setup"
          : "info",
      summary: gatewayRuntimeReady
        ? "The mission runner is attached to the live gateway runtime."
        : capabilityNeeds.gatewayRequired
          ? "This goal appears to depend on gateway/runtime control, but no live gateway runtime is attached."
          : "Gateway runtime signals are not yet attached; mission persistence still works, but live runtime broadcasts may not be available in this context.",
      blocker: capabilityNeeds.gatewayRequired && !gatewayRuntimeReady,
    },
    {
      id: "exec-tool",
      category: "tool",
      title: "Exec tool exposure",
      status: execToolReady ? "ready" : "blocked",
      summary: execToolReady
        ? "The exec tool is exposed for mission execution."
        : "The exec tool is blocked by current tool policy. Claw needs exec for full-access mission work.",
      blocker: !execToolReady,
    },
    {
      id: "process-tool",
      category: "tool",
      title: "Process tool exposure",
      status: processToolReady ? "ready" : "blocked",
      summary: processToolReady
        ? "The process tool is exposed for background command handling."
        : "The process tool is blocked by current tool policy. Claw needs process for full-access mission work.",
      blocker: !processToolReady,
    },
    {
      id: "gateway-tool",
      category: "tool",
      title: "Gateway control tool exposure",
      status: gatewayToolReady ? "ready" : "info",
      summary: gatewayToolReady
        ? "Gateway control actions are available to Claw."
        : "Gateway control actions are not currently exposed. Mission execution can still proceed, but runtime control-plane actions will be limited.",
    },
    {
      id: "helper-tools",
      category: "tool",
      title: "Optional helper-session tools",
      status:
        capabilityNeeds.helperSessionsUseful && !helperToolsReady
          ? "info"
          : helperToolsReady
            ? "ready"
            : "info",
      summary: helperToolsReady
        ? "Sessions/subagent tools are available for bounded helper work when useful."
        : capabilityNeeds.helperSessionsUseful
          ? "The mission may benefit from helper sessions, but sessions_spawn/subagents are not fully exposed. Claw will stay single-runner only."
          : "Helper-session tools are optional for this mission.",
    },
    {
      id: "browser-runtime",
      category: "browser",
      title: "Browser automation availability",
      status: capabilityNeeds.browserRequired
        ? browserReady
          ? "ready"
          : "needs_setup"
        : browserToolReady && browserPluginReady && browserConfigured
          ? "ready"
          : "info",
      summary: browserSummary,
      detail: browserDetail,
      blocker: capabilityNeeds.browserRequired && !browserReady,
    },
    {
      id: "cron-tool",
      category: "tool",
      title: "Scheduling tool exposure",
      status:
        capabilityNeeds.schedulingLikely && !cronToolReady
          ? "info"
          : cronToolReady
            ? "ready"
            : "info",
      summary: cronToolReady
        ? "Cron is available if the mission needs scheduled follow-up work."
        : capabilityNeeds.schedulingLikely
          ? "This goal mentions delayed or recurring work, but the cron tool is not exposed."
          : "Cron is optional for this mission.",
    },
    {
      id: "likely-auth",
      category: "auth",
      title: "Likely authentication blockers",
      status: capabilityNeeds.manualAuthRequired ? "needs_setup" : "info",
      summary: capabilityNeeds.manualAuthRequired
        ? "This goal explicitly mentions login, CAPTCHA, MFA, or similar manual authentication. Expect operator intervention before autonomous progress continues."
        : capabilityNeeds.likelyAuthDomains.length > 0
          ? `This mission may depend on existing authentication for: ${capabilityNeeds.likelyAuthDomains.join(", ")}.`
          : "No obvious authentication blocker was inferred from the goal text.",
      detail: capabilityNeeds.manualAuthRequired
        ? "Manual-auth requirements are inferred directly from the approved goal and are treated as true blockers for unattended execution."
        : null,
      blocker: capabilityNeeds.manualAuthRequired,
    },
    {
      id: "external-systems",
      category: "external",
      title: "Likely external systems",
      status: capabilityNeeds.likelyExternalSystems.length > 0 ? "info" : "ready",
      summary:
        capabilityNeeds.likelyExternalSystems.length > 0
          ? `The mission likely touches: ${capabilityNeeds.likelyExternalSystems.join(", ")}.`
          : "No obvious external system dependencies were inferred from the goal text.",
    },
  ];
}

function buildStartApprovalDecision(nowIso: string): ClawPendingDecision {
  return {
    id: crypto.randomUUID(),
    kind: "start_approval",
    title: "Approve mission start",
    summary: "Review the generated mission packet and approve once to let Claw begin execution.",
    requestedAt: nowIso,
    status: "pending",
  };
}

function buildPreflightDecision(nowIso: string, summary: string): ClawPendingDecision {
  return {
    id: crypto.randomUUID(),
    kind: "preflight_blocker",
    title: "Resolve preflight blockers",
    summary,
    requestedAt: nowIso,
    status: "pending",
  };
}

function buildRecoveryUncertainDecision(nowIso: string, summary: string): ClawPendingDecision {
  return {
    id: crypto.randomUUID(),
    kind: "recovery_uncertain",
    title: "Confirm recovery continuation",
    summary,
    requestedAt: nowIso,
    status: "pending",
  };
}

function buildDefaultControlState(nowIso: string, autonomyEnabled: boolean): ClawControlState {
  return {
    autonomyEnabled,
    pauseAll: false,
    stopAllNowRequestedAt: null,
    updatedAt: nowIso,
  };
}

function isRecoverySafeToResumeAutomatically(state: ClawMissionStateRecord): boolean {
  if (state.status === "verifying") {
    return true;
  }
  if (state.status !== "running") {
    return false;
  }
  return (
    state.runCycleCount === 0 &&
    state.verifyCycleCount === 0 &&
    state.recentEvidence.length === 0 &&
    state.lastFailureSummary == null
  );
}

function buildRecoveryUncertainSummary(state: ClawMissionStateRecord): string {
  const reasons: string[] = [];
  if (state.runCycleCount > 0) {
    reasons.push(`runner cycles completed: ${state.runCycleCount}`);
  }
  if (state.recentEvidence.length > 0) {
    reasons.push(`durable evidence captured: ${state.recentEvidence.join("; ")}`);
  }
  if (state.lastFailureSummary) {
    reasons.push(`last runner error: ${state.lastFailureSummary}`);
  }
  const suffix = reasons.length > 0 ? ` Last checkpoint details: ${reasons.join(" | ")}.` : "";
  return `Mission recovery needs operator confirmation because active runner work may have left partially applied side effects before restart.${suffix}`;
}

function buildInboxItems(missions: readonly ClawMissionStateRecord[]): ClawInboxItem[] {
  const items: ClawInboxItem[] = [];
  for (const mission of missions) {
    for (const decision of mission.decisions) {
      if (!isActionableDecisionForMission(mission, decision)) {
        continue;
      }
      items.push({
        id: decision.id,
        missionId: mission.id,
        missionTitle: mission.title,
        kind: "decision",
        title: decision.title,
        summary: decision.summary,
        requestedAt: decision.requestedAt,
        status: decision.status,
      });
    }
    if (mission.status === "blocked" && mission.blockedSummary) {
      items.push({
        id: `${mission.id}:blocked`,
        missionId: mission.id,
        missionTitle: mission.title,
        kind: "blocker",
        title: "Mission blocked",
        summary: mission.blockedSummary,
        requestedAt: mission.updatedAt,
        status: "pending",
      });
    }
  }
  return items.toSorted((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

function renderPreflightMarkdown(checks: readonly ClawPreflightCheck[]): string {
  const lines = checks.map(
    (check) =>
      `- [${check.status === "ready" ? "x" : " "}] ${check.title} (${check.status})\n  ${check.summary}`,
  );
  return ["# Prechecks", "", ...lines].join("\n");
}

function renderDecisionsMarkdown(decisions: readonly ClawPendingDecision[]): string {
  if (decisions.length === 0) {
    return "# Decisions\n\nNo pending decisions.";
  }
  const lines = decisions.map((decision) => {
    const response =
      decision.response && decision.response.action
        ? `\n  Response: ${decision.response.action} at ${decision.response.respondedAt}`
        : "";
    return `- ${decision.title} (${decision.status})\n  ${decision.summary}${response}`;
  });
  return ["# Decisions", "", ...lines].join("\n");
}

function renderBlockersMarkdown(state: ClawMissionStateRecord): string {
  const blockers = state.preflight.filter((check) => check.blocker);
  if (!state.blockedSummary && blockers.length === 0) {
    return "# Blockers\n\nNo active blockers.";
  }
  return [
    "# Blockers",
    "",
    ...(state.blockedSummary ? [`- ${state.blockedSummary}`] : []),
    ...blockers.map((check) => `- ${check.title}: ${check.summary}`),
  ].join("\n");
}

function renderArtifactsMarkdown(
  state: ClawMissionStateRecord,
  artifacts: readonly ClawArtifactEntry[],
): string {
  return [
    "# Artifacts",
    "",
    `- Mission directory: ${state.missionDir}`,
    `- Artifacts directory: ${state.artifactsDir}`,
    `- Logs directory: ${state.logsDir}`,
    `- Audit log: ${state.auditLogPath}`,
    "",
    "## Recorded Artifacts",
    "",
    ...(artifacts.length > 0
      ? artifacts.map(
          (artifact) =>
            `- ${artifact.name} (${artifact.kind})${
              typeof artifact.sizeBytes === "number" ? ` - ${artifact.sizeBytes} bytes` : ""
            }`,
        )
      : ["- No artifacts recorded yet."]),
  ].join("\n");
}

function renderMissionMarkdown(state: ClawMissionStateRecord): string {
  return [
    `# ${state.title}`,
    "",
    `- Mission ID: ${state.id}`,
    `- Status: ${state.status}`,
    `- Created: ${state.createdAt}`,
    `- Updated: ${state.updatedAt}`,
    `- Workspace: ${state.workspaceDir}`,
    `- Flow ID: ${state.flowId ?? "n/a"}`,
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## Current Step",
    "",
    state.currentStep ?? "Waiting for the next state transition.",
  ].join("\n");
}

function renderScopeMarkdown(state: ClawMissionStateRecord): string {
  const scopeIn = state.missionPlan.scopeIn.map((item) => `- ${item}`);
  const scopeOut = state.missionPlan.scopeOut.map((item) => `- ${item}`);
  return [
    "# Project Scope",
    "",
    "## Goal",
    "",
    state.goal,
    "",
    "## In Scope",
    "",
    ...scopeIn,
    "",
    "## Out of Scope",
    "",
    ...scopeOut,
  ].join("\n");
}

function renderPlanMarkdown(state: ClawMissionStateRecord): string {
  const nextCheckpoint =
    state.status === "awaiting_setup"
      ? "Resolve the blocking preflight items and rerun preflight."
      : state.status === "awaiting_approval"
        ? "Review the packet and approve mission start."
        : state.status === "queued"
          ? "Wait for the runner to claim the mission and begin execution."
          : state.status === "verifying"
            ? "Run the required fresh-context verification pass."
            : state.status === "blocked"
              ? state.blockedSummary ?? "Unblock the mission and continue."
              : state.status === "done"
                ? "Mission is complete."
                : state.currentStep ?? "Continue execution from the current repository state.";
  const recentEvidence =
    state.recentEvidence.length > 0
      ? state.recentEvidence.map((item) => `- ${item}`)
      : ["- No durable evidence recorded yet."];
  const plannedPhases = state.missionPlan.phases.map((item, index) => `${index + 1}. ${item}`);
  return [
    "# Project Plan",
    "",
    "## Mission Goal",
    "",
    state.goal,
    "",
    "## Strategy Summary",
    "",
    state.missionPlan.summary,
    "",
    "## Planned Phases",
    "",
    ...plannedPhases,
    "",
    "## Current Checkpoint",
    "",
    `- Status: ${state.status}`,
    `- Current step: ${state.currentStep ?? "Pending mission execution."}`,
    `- Next checkpoint: ${nextCheckpoint}`,
    "",
    "## Recent Evidence",
    "",
    ...recentEvidence,
  ].join("\n");
}

function renderTasksMarkdown(state: ClawMissionStateRecord): string {
  const preflightReady = !hasBlockingPreflight(state.preflight);
  const executionStarted =
    state.startedAt != null ||
    state.status === "running" ||
    state.status === "recovering" ||
    state.status === "verifying" ||
    state.status === "done" ||
    state.status === "failed";
  const verificationDone = state.status === "done";
  const executionLine =
    state.status === "blocked"
      ? `${state.currentStep ?? "Mission blocked"}${state.blockedSummary ? ` (${state.blockedSummary})` : ""}`
      : state.currentStep ?? "Execute the current mission step.";
  const plannedTasks = state.missionPlan.tasks.map((task) => `- ${task}`);
  return [
    "# Project Tasks",
    "",
    "## Execution Checklist",
    "",
    "- [x] Generate mission packet",
    `- [${preflightReady ? "x" : " "}] Clear required preflight blockers`,
    `- [${state.approvedAt ? "x" : " "}] Approve mission start`,
    `- [${executionStarted ? "x" : " "}] Execute the current mission objective: ${executionLine}`,
    `- [${verificationDone ? "x" : " "}] Pass the fresh verification check against PROJECT_DONE_CRITERIA.md`,
    "",
    "## Mission-Specific Tasks",
    "",
    ...plannedTasks,
    "",
    "## Current Focus",
    "",
    `- ${executionLine}`,
  ].join("\n");
}

function renderStatusMarkdown(state: ClawMissionStateRecord): string {
  return [
    "# Project Status",
    "",
    `- Status: ${state.status}`,
    `- Updated: ${state.updatedAt}`,
    `- Current Step: ${state.currentStep ?? "n/a"}`,
    `- Blocked Summary: ${state.blockedSummary ?? "n/a"}`,
    `- Flow Status: ${state.flowStatus ?? "n/a"}`,
  ].join("\n");
}

function renderDoneCriteriaMarkdown(state: ClawMissionStateRecord): string {
  const criteria = state.missionPlan.doneCriteria.map((item) => `- ${item}`);
  return [
    "# Project Done Criteria",
    "",
    ...criteria,
    "",
    `Mission: ${state.title}`,
  ].join("\n");
}

function toSummary(state: ClawMissionStateRecord) {
  return {
    id: state.id,
    title: state.title,
    goal: state.goal,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    approvedAt: state.approvedAt ?? null,
    startedAt: state.startedAt ?? null,
    endedAt: state.endedAt ?? null,
    workspaceDir: state.workspaceDir,
    missionDir: state.missionDir,
    flowId: state.flowId ?? null,
    flowRevision: state.flowRevision ?? null,
    flowStatus: state.flowStatus ?? null,
    currentStep: state.currentStep ?? null,
    blockedSummary: state.blockedSummary ?? null,
    requiresAttention: requiresAttention(state),
  };
}

function toDetail(state: ClawMissionStateRecord): ClawMissionDetail {
  return {
    ...toSummary(state),
    preflight: [...state.preflight],
    decisions: [...state.decisions],
    files: [...state.files],
    artifactsDir: state.artifactsDir,
    logsDir: state.logsDir,
    auditLogPath: state.auditLogPath,
    auditCount: state.auditCount,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertMissionStateRecord(raw: unknown): ClawMissionStateRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("Mission state is not an object.");
  }
  const state = raw as Partial<ClawMissionStateRecord>;
  if (
    state.version !== 1 ||
    typeof state.id !== "string" ||
    typeof state.title !== "string" ||
    typeof state.goal !== "string" ||
    typeof state.status !== "string" ||
    typeof state.workspaceDir !== "string" ||
    typeof state.missionDir !== "string"
  ) {
    throw new Error("Mission state is missing required fields.");
  }
  const fallbackMissionPlan = buildFallbackMissionPlan({
    title: state.title,
    goal: state.goal,
  });
  return {
    ...state,
    approvedAt: state.approvedAt ?? null,
    startedAt: state.startedAt ?? null,
    endedAt: state.endedAt ?? null,
    flowId: state.flowId ?? null,
    flowRevision: state.flowRevision ?? null,
    flowStatus: state.flowStatus ?? null,
    currentStep: state.currentStep ?? null,
    blockedSummary: state.blockedSummary ?? null,
    preflight: Array.isArray(state.preflight) ? state.preflight : [],
    decisions: Array.isArray(state.decisions) ? state.decisions : [],
    files: Array.isArray(state.files) ? state.files : [],
    artifactsDir: typeof state.artifactsDir === "string" ? state.artifactsDir : "",
    logsDir: typeof state.logsDir === "string" ? state.logsDir : "",
    auditLogPath: typeof state.auditLogPath === "string" ? state.auditLogPath : "",
    auditCount: typeof state.auditCount === "number" ? state.auditCount : 0,
    runnerSessionId: typeof state.runnerSessionId === "string" ? state.runnerSessionId : null,
    runnerSessionFile: typeof state.runnerSessionFile === "string" ? state.runnerSessionFile : null,
    recoveryTargetStatus:
      state.recoveryTargetStatus === "running" || state.recoveryTargetStatus === "verifying"
        ? state.recoveryTargetStatus
        : null,
    recentEvidence: Array.isArray(state.recentEvidence) ? normalizeEvidence(state.recentEvidence) : [],
    consecutiveFailureCount:
      typeof state.consecutiveFailureCount === "number" ? state.consecutiveFailureCount : 0,
    consecutiveNoProgressCount:
      typeof state.consecutiveNoProgressCount === "number" ? state.consecutiveNoProgressCount : 0,
    consecutiveVerifierRejectCount:
      typeof state.consecutiveVerifierRejectCount === "number"
        ? state.consecutiveVerifierRejectCount
        : 0,
    lastFailureSummary:
      typeof state.lastFailureSummary === "string" ? state.lastFailureSummary : null,
    lastVerifierRejectionSignature:
      typeof state.lastVerifierRejectionSignature === "string"
        ? state.lastVerifierRejectionSignature
        : null,
    runCycleCount: typeof state.runCycleCount === "number" ? state.runCycleCount : 0,
    verifyCycleCount: typeof state.verifyCycleCount === "number" ? state.verifyCycleCount : 0,
    missionPlan:
      state.missionPlan && typeof state.missionPlan === "object"
        ? {
            source: state.missionPlan.source === "planned" ? "planned" : "fallback",
            summary: normalizeSummaryText(state.missionPlan.summary, fallbackMissionPlan.summary),
            scopeIn: normalizeTextList(state.missionPlan.scopeIn, 6, fallbackMissionPlan.scopeIn),
            scopeOut: normalizeTextList(state.missionPlan.scopeOut, 6, fallbackMissionPlan.scopeOut),
            phases: normalizeTextList(state.missionPlan.phases, 8, fallbackMissionPlan.phases),
            tasks: normalizeTextList(state.missionPlan.tasks, 10, fallbackMissionPlan.tasks),
            doneCriteria: normalizeTextList(
              state.missionPlan.doneCriteria,
              8,
              fallbackMissionPlan.doneCriteria,
            ),
          }
        : fallbackMissionPlan,
  } as ClawMissionStateRecord;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function appendAuditLine(filePath: string, entry: ClawAuditEntry): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function syncWithFlow(state: ClawMissionStateRecord): ClawMissionStateRecord {
  if (!state.flowId) {
    return state;
  }
  const flow = getTaskFlowById(state.flowId);
  if (!flow) {
    return state;
  }
  return {
    ...state,
    flowRevision: flow.revision,
    flowStatus: flow.status as ClawManagedFlowStatus,
    currentStep: flow.currentStep ?? state.currentStep ?? null,
    blockedSummary: flow.blockedSummary ?? state.blockedSummary ?? null,
  };
}

export function createClawMissionService(deps: ClawServiceDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const resolveWorkspaceDir = deps.resolveWorkspaceDir ?? defaultResolveWorkspaceDir;
  const loadClawConfig = deps.loadConfig ?? loadConfig;
  const runMissionAgent = deps.runEmbeddedPiAgent ?? runEmbeddedPiAgent;
  const inspectBrowserReadiness = deps.inspectBrowserReadiness ?? defaultInspectBrowserReadiness;

  function resolveClawExecutionConfig(): {
    autonomyDefault: boolean;
    maxActiveMissions: number;
  } {
    const cfg = loadClawConfig();
    return {
      autonomyDefault: cfg.claw?.autonomyDefault !== false,
      maxActiveMissions:
        typeof cfg.claw?.maxActiveMissions === "number" &&
        Number.isFinite(cfg.claw.maxActiveMissions) &&
        cfg.claw.maxActiveMissions > 0
          ? Math.floor(cfg.claw.maxActiveMissions)
          : CLAW_MAX_ACTIVE_MISSIONS,
    };
  }

  function resolveMissionsRoot(workspaceDir = resolveWorkspaceDir()) {
    return path.join(workspaceDir, MISSIONS_DIRNAME);
  }

  function resolveMissionDir(missionId: string, workspaceDir = resolveWorkspaceDir()) {
    return path.join(resolveMissionsRoot(workspaceDir), missionId);
  }

  function resolveMissionStatePath(missionId: string, workspaceDir = resolveWorkspaceDir()) {
    return path.join(resolveMissionDir(missionId, workspaceDir), MISSION_STATE_FILENAME);
  }

  function resolveControlStatePath(workspaceDir = resolveWorkspaceDir()) {
    return path.join(resolveMissionsRoot(workspaceDir), MISSION_CONTROL_FILENAME);
  }

  async function ensureRoot(workspaceDir = resolveWorkspaceDir()) {
    await fs.mkdir(resolveMissionsRoot(workspaceDir), { recursive: true });
    return workspaceDir;
  }

  async function loadControlState(workspaceDir = resolveWorkspaceDir()): Promise<ClawControlState> {
    await ensureRoot(workspaceDir);
    const controlPath = resolveControlStatePath(workspaceDir);
    const existing = await readJsonFile<ClawControlState>(controlPath);
    if (existing) {
      return existing;
    }
    const next = buildDefaultControlState(
      isoNow(now),
      resolveClawExecutionConfig().autonomyDefault,
    );
    await writeJsonFile(controlPath, next);
    return next;
  }

  async function saveControlState(
    control: ClawControlState,
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawControlState> {
    await ensureRoot(workspaceDir);
    await writeJsonFile(resolveControlStatePath(workspaceDir), control);
    return control;
  }

  async function loadMissionState(
    missionId: string,
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionStateRecord | null> {
    const raw = await readJsonFile<unknown>(resolveMissionStatePath(missionId, workspaceDir));
    if (!raw) {
      return null;
    }
    return syncWithFlow(assertMissionStateRecord(raw));
  }

  async function saveMissionState(state: ClawMissionStateRecord): Promise<ClawMissionStateRecord> {
    const synced = syncWithFlow({
      ...state,
      files: missionFilesForState(state),
    });
    await writeJsonFile(path.join(synced.missionDir, MISSION_STATE_FILENAME), synced);
    return synced;
  }

  async function writeStaticMissionDocs(state: ClawMissionStateRecord): Promise<void> {
    await Promise.all([
      fs.writeFile(path.join(state.missionDir, "PROJECT_SCOPE.md"), renderScopeMarkdown(state), "utf-8"),
      fs.writeFile(
        path.join(state.missionDir, "PROJECT_DONE_CRITERIA.md"),
        renderDoneCriteriaMarkdown(state),
        "utf-8",
      ),
    ]);
  }

  async function writeDynamicMissionDocs(state: ClawMissionStateRecord): Promise<void> {
    const artifactEntries = await listArtifactEntriesForState(state);
    await Promise.all([
      fs.writeFile(path.join(state.missionDir, "MISSION.md"), renderMissionMarkdown(state), "utf-8"),
      fs.writeFile(
        path.join(state.missionDir, "PROJECT_STATUS.md"),
        renderStatusMarkdown(state),
        "utf-8",
      ),
      fs.writeFile(path.join(state.missionDir, "PROJECT_PLAN.md"), renderPlanMarkdown(state), "utf-8"),
      fs.writeFile(
        path.join(state.missionDir, "PROJECT_TASKS.md"),
        renderTasksMarkdown(state),
        "utf-8",
      ),
      fs.writeFile(
        path.join(state.missionDir, "PRECHECKS.md"),
        renderPreflightMarkdown(state.preflight),
        "utf-8",
      ),
      fs.writeFile(
        path.join(state.missionDir, "BLOCKERS.md"),
        renderBlockersMarkdown(state),
        "utf-8",
      ),
      fs.writeFile(
        path.join(state.missionDir, "DECISIONS.md"),
        renderDecisionsMarkdown(state.decisions),
        "utf-8",
      ),
      fs.writeFile(
        path.join(state.missionDir, "ARTIFACTS.md"),
        renderArtifactsMarkdown(state, artifactEntries),
        "utf-8",
      ),
    ]);
  }

  async function readMissionPromptFiles(
    state: ClawMissionStateRecord,
  ): Promise<Array<{ name: string; content: string }>> {
    const names = [
      "MISSION.md",
      "PROJECT_SCOPE.md",
      "PROJECT_PLAN.md",
      "PROJECT_TASKS.md",
      "PROJECT_STATUS.md",
      "PROJECT_DONE_CRITERIA.md",
      "PRECHECKS.md",
      "BLOCKERS.md",
      "DECISIONS.md",
    ] as const;
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        content: await fs.readFile(path.join(state.missionDir, name), "utf-8"),
      })),
    );
    return files;
  }

  async function listArtifactEntriesForState(
    state: ClawMissionStateRecord,
  ): Promise<ClawArtifactEntry[]> {
    if (!(await fileExists(state.artifactsDir))) {
      return [];
    }
    const entries = await fs.readdir(state.artifactsDir, { withFileTypes: true });
    const artifacts = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(state.artifactsDir, entry.name);
        const stats = await fs.stat(entryPath);
        return {
          name: entry.name,
          path: entryPath,
          kind: entry.isDirectory() ? "directory" : "file",
          updatedAt: stats.mtime.toISOString(),
          sizeBytes: entry.isDirectory() ? null : stats.size,
        } satisfies ClawArtifactEntry;
      }),
    );
    return artifacts.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  async function recordAudit(
    state: ClawMissionStateRecord,
    entry: Omit<ClawAuditEntry, "id" | "missionId" | "at"> & { at?: string },
  ): Promise<ClawAuditEntry> {
    const auditEntry: ClawAuditEntry = {
      id: crypto.randomUUID(),
      missionId: state.id,
      at: entry.at ?? isoNow(now),
      actor: entry.actor,
      type: entry.type,
      summary: entry.summary,
      detail: entry.detail ?? null,
    };
    await appendAuditLine(state.auditLogPath, auditEntry);
    state.auditCount += 1;
    return auditEntry;
  }

  async function loadAllMissionStates(
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionStateRecord[]> {
    const root = resolveMissionsRoot(workspaceDir);
    if (!(await fileExists(root))) {
      return [];
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    const missions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await loadMissionState(entry.name, workspaceDir);
          } catch (error) {
            log.warn("Failed to load mission state", { missionId: entry.name, error });
            return null;
          }
        }),
    );
    return missions
      .filter((mission): mission is ClawMissionStateRecord => Boolean(mission))
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async function reconcileMissionStateForControl(
    state: ClawMissionStateRecord,
    control: ClawControlState,
  ): Promise<boolean> {
    const nowIso = isoNow(now);
    const blockingSummary = summarizeBlockingPreflight(state.preflight);
    const beforeSignature = JSON.stringify({
      status: state.status,
      currentStep: state.currentStep,
      blockedSummary: state.blockedSummary,
      approvedAt: state.approvedAt,
      startedAt: state.startedAt,
      flowRevision: state.flowRevision,
      flowStatus: state.flowStatus,
      decisions: state.decisions,
      auditCount: state.auditCount,
    });

    if (control.stopAllNowRequestedAt && ACTIVE_MISSION_STATUSES.has(state.status)) {
      moveMissionToWaiting({
        state,
        status: "paused",
        currentStep: "Emergency stop requested by operator.",
        waitKind: "emergency_stop",
        note: control.stopAllNowRequestedAt,
      });
      await recordAudit(state, {
        actor: "operator",
        type: "mission.stopAllNow",
        summary: "Mission halted by global emergency stop.",
      });
      await saveMissionState(state);
      await writeDynamicMissionDocs(state);
      return true;
    }

    if (control.pauseAll && ACTIVE_MISSION_STATUSES.has(state.status)) {
      moveMissionToWaiting({
        state,
        status: "paused",
        currentStep: "Paused by global control.",
        waitKind: "global_pause",
      });
      await recordAudit(state, {
        actor: "operator",
        type: "mission.pauseAll",
        summary: "Mission paused by the global pause control.",
      });
      await saveMissionState(state);
      await writeDynamicMissionDocs(state);
      return true;
    }

    if (state.status === "awaiting_setup") {
      if (!blockingSummary) {
        moveMissionToWaiting({
          state,
          status: "awaiting_approval",
          currentStep: "Awaiting mission start approval.",
          waitKind: "approval",
        });
        resolvePendingDecisionByKindWithContinue(
          state,
          "preflight_blocker",
          nowIso,
          "Preflight reran without blockers.",
        );
        ensurePendingStartDecision(state, nowIso);
      }
    } else if (state.status === "awaiting_approval") {
      if (blockingSummary) {
        moveMissionToWaiting({
          state,
          status: "awaiting_setup",
          currentStep: "Resolve preflight blockers before mission approval.",
          waitKind: "preflight_setup",
          blockedSummary: blockingSummary,
        });
        ensurePendingPreflightDecision(state, nowIso, blockingSummary);
      }
    } else if (state.status === "queued") {
      if (blockingSummary) {
        moveMissionToWaiting({
          state,
          status: "awaiting_setup",
          currentStep: "Resolve preflight blockers before mission execution.",
          waitKind: "preflight_setup",
          blockedSummary: blockingSummary,
        });
        ensurePendingPreflightDecision(state, nowIso, blockingSummary);
      } else {
        const queuedStep = resolveQueuedCurrentStep(control);
        if (state.currentStep !== queuedStep) {
          state.currentStep = queuedStep;
        }
      }
    } else if (state.status === "paused") {
      const waitKind = getFlowWaitKind(state);
      const pausedByGlobalControl = waitKind === "global_pause" || waitKind === "emergency_stop";
      if (pausedByGlobalControl && shouldStartMissionImmediately(control)) {
        moveMissionToQueued(state, "Queued after the global control was cleared.");
        await recordAudit(state, {
          actor: "system",
          type: "mission.resumed",
          summary: "Mission re-queued after the global control was cleared.",
        });
      }
    }

    if (state.status === "awaiting_setup" && blockingSummary) {
      state.blockedSummary = blockingSummary;
      ensurePendingPreflightDecision(state, nowIso, blockingSummary);
    }

    if (state.status === "awaiting_approval") {
      ensurePendingStartDecision(state, nowIso);
    }

    const afterSignature = JSON.stringify({
      status: state.status,
      currentStep: state.currentStep,
      blockedSummary: state.blockedSummary,
      approvedAt: state.approvedAt,
      startedAt: state.startedAt,
      flowRevision: state.flowRevision,
      flowStatus: state.flowStatus,
      decisions: state.decisions,
      auditCount: state.auditCount,
    });
    if (beforeSignature === afterSignature) {
      return false;
    }

    await saveMissionState(state);
    await writeDynamicMissionDocs(state);
    return true;
  }

  async function reconcileMissionStates(
    workspaceDir = resolveWorkspaceDir(),
    control?: ClawControlState,
  ): Promise<void> {
    const effectiveControl = control ?? (await loadControlState(workspaceDir));
    const missions = await loadAllMissionStates(workspaceDir);
    for (const mission of missions) {
      if (isTerminalMissionStatus(mission.status)) {
        continue;
      }
      await reconcileMissionStateForControl(mission, effectiveControl);
    }
  }

  async function buildDashboard(workspaceDir = resolveWorkspaceDir()): Promise<ClawMissionDashboard> {
    const control = await loadControlState(workspaceDir);
    await reconcileMissionStates(workspaceDir, control);
    const missions = await loadAllMissionStates(workspaceDir);
    return {
      missions: missions.map((mission) => toSummary(mission)),
      control,
      inbox: buildInboxItems(missions),
    };
  }

  async function getMissionSnapshot(
    missionId: string,
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionDetailSnapshot> {
    const dashboard = await buildDashboard(workspaceDir);
    const mission = await loadMissionState(missionId, workspaceDir);
    return {
      ...dashboard,
      mission: mission ? toDetail(mission) : null,
    };
  }

  async function updateMission(
    missionId: string,
    mutate: (state: ClawMissionStateRecord) => Promise<ClawMissionStateRecord>,
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionDetailSnapshot> {
    const current = await loadMissionState(missionId, workspaceDir);
    if (!current) {
      throw new Error(`Unknown mission: ${missionId}`);
    }
    const next = await mutate({
      ...current,
      decisions: [...current.decisions],
      preflight: [...current.preflight],
    });
    next.updatedAt = isoNow(now);
    next.files = missionFilesForState(next);
    await saveMissionState(next);
    await writeDynamicMissionDocs(next);
    return await getMissionSnapshot(missionId, workspaceDir);
  }

  function resolvePendingDecision(
    state: ClawMissionStateRecord,
    decisionId: string,
  ): ClawPendingDecision | undefined {
    return state.decisions.find((decision) => decision.id === decisionId);
  }

  function resolveStartDecision(state: ClawMissionStateRecord): ClawPendingDecision | undefined {
    return state.decisions.find(
      (decision) => decision.kind === "start_approval" && decision.status === "pending",
    );
  }

  function resolvePendingDecisionByKind(
    state: ClawMissionStateRecord,
    kind: ClawPendingDecision["kind"],
  ): ClawPendingDecision | undefined {
    return state.decisions.find((decision) => decision.kind === kind && decision.status === "pending");
  }

  function ensurePendingStartDecision(state: ClawMissionStateRecord, nowIso: string): void {
    if (!resolveStartDecision(state)) {
      state.decisions.push(buildStartApprovalDecision(nowIso));
    }
  }

  function ensurePendingPreflightDecision(
    state: ClawMissionStateRecord,
    nowIso: string,
    summary: string,
  ): void {
    const existing = resolvePendingDecisionByKind(state, "preflight_blocker");
    if (existing) {
      existing.summary = summary;
      return;
    }
    state.decisions.push(buildPreflightDecision(nowIso, summary));
  }

  function ensurePendingRecoveryDecision(
    state: ClawMissionStateRecord,
    nowIso: string,
    summary: string,
  ): void {
    const existing = resolvePendingDecisionByKind(state, "recovery_uncertain");
    if (existing) {
      existing.summary = summary;
      return;
    }
    state.decisions.push(buildRecoveryUncertainDecision(nowIso, summary));
  }

  function resolvePendingDecisionByKindWithContinue(
    state: ClawMissionStateRecord,
    kind: ClawPendingDecision["kind"],
    nowIso: string,
    note: string,
  ): void {
    for (const decision of state.decisions) {
      if (decision.kind !== kind || decision.status !== "pending") {
        continue;
      }
      decision.status = "resolved";
      decision.response = {
        action: "continue",
        note,
        respondedAt: nowIso,
      };
    }
  }

  function resolveAllPendingDecisions(
    state: ClawMissionStateRecord,
    action: ClawDecisionAction,
    nowIso: string,
    note?: string | null,
  ): void {
    for (const decision of state.decisions) {
      if (decision.status !== "pending") {
        continue;
      }
      decision.status = "resolved";
      decision.response = {
        action,
        note: note ?? null,
        respondedAt: nowIso,
      };
    }
  }

  function requireMissionStatus(
    state: ClawMissionStateRecord,
    allowed: readonly ClawMissionStatus[],
    action: string,
  ): void {
    if (!allowed.includes(state.status)) {
      throw new Error(`Cannot ${action} mission from status "${state.status}".`);
    }
  }

  function getFlowOrThrow(state: ClawMissionStateRecord) {
    const flow = state.flowId ? getTaskFlowById(state.flowId) : null;
    if (!flow) {
      throw new Error(`Mission flow is unavailable for ${state.id}.`);
    }
    return flow;
  }

  function getFlowWaitKind(state: ClawMissionStateRecord): string | null {
    const waitJson = getFlowOrThrow(state).waitJson;
    if (!waitJson || typeof waitJson !== "object" || Array.isArray(waitJson)) {
      return null;
    }
    const kind = (waitJson as Record<string, unknown>).kind;
    return typeof kind === "string" && kind.trim() ? kind : null;
  }

  function moveMissionToWaiting(params: {
    state: ClawMissionStateRecord;
    status: Exclude<ClawMissionStatus, "queued" | "running" | "cancelled">;
    currentStep: string;
    waitKind: string;
    note?: string | null;
    blockedSummary?: string | null;
  }): void {
    const flow = getFlowOrThrow(params.state);
    const result = setFlowWaiting({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep: params.currentStep,
      stateJson: {
        missionId: params.state.id,
        missionStatus: params.status,
      },
      waitJson: {
        kind: params.waitKind,
        note: params.note ?? null,
      },
      blockedSummary: params.blockedSummary ?? null,
    });
    if (!result.applied) {
      throw new Error(`Failed to move mission ${params.state.id} to ${params.status}.`);
    }
    params.state.status = params.status;
    params.state.currentStep = params.currentStep;
    params.state.blockedSummary = params.blockedSummary ?? null;
    params.state.flowRevision = result.flow.revision;
    params.state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    params.state.recoveryTargetStatus = null;
  }

  function moveMissionToQueued(state: ClawMissionStateRecord, currentStep: string): void {
    const flow = getFlowOrThrow(state);
    const result = resumeFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      status: "queued",
      currentStep,
      stateJson: {
        missionId: state.id,
        missionStatus: "queued",
      },
    });
    if (!result.applied) {
      throw new Error(`Failed to queue mission ${state.id}.`);
    }
    state.status = "queued";
    state.currentStep = currentStep;
    state.blockedSummary = null;
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    state.recoveryTargetStatus = null;
  }

  function moveMissionToRunning(state: ClawMissionStateRecord, currentStep: string): void {
    const flow = getFlowOrThrow(state);
    const result = resumeFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      status: "running",
      currentStep,
      stateJson: {
        missionId: state.id,
        missionStatus: "running",
      },
    });
    if (!result.applied) {
      throw new Error(`Failed to start mission ${state.id}.`);
    }
    state.status = "running";
    state.startedAt = state.startedAt ?? isoNow(now);
    state.currentStep = currentStep;
    state.blockedSummary = null;
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    state.recoveryTargetStatus = null;
  }

  function moveMissionToVerifying(state: ClawMissionStateRecord, currentStep: string): void {
    const flow = getFlowOrThrow(state);
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep,
        stateJson: {
          missionId: state.id,
          missionStatus: "verifying",
        },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
      },
    });
    if (!result.applied) {
      throw new Error(`Failed to move mission ${state.id} to verifying.`);
    }
    state.status = "verifying";
    state.currentStep = currentStep;
    state.blockedSummary = null;
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    state.recoveryTargetStatus = null;
  }

  function moveMissionToRecovering(
    state: ClawMissionStateRecord,
    targetStatus: Extract<ClawMissionStatus, "running" | "verifying">,
    currentStep: string,
  ): void {
    const flow = getFlowOrThrow(state);
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep,
        stateJson: {
          missionId: state.id,
          missionStatus: "recovering",
          recoveryTargetStatus: targetStatus,
        },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
      },
    });
    if (!result.applied) {
      throw new Error(`Failed to move mission ${state.id} to recovering.`);
    }
    state.status = "recovering";
    state.currentStep = currentStep;
    state.blockedSummary = null;
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    state.recoveryTargetStatus = targetStatus;
  }

  function syncActiveMissionFlow(state: ClawMissionStateRecord): void {
    const flow = getFlowOrThrow(state);
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      patch: {
        status: "running",
        currentStep: state.currentStep,
        stateJson: {
          missionId: state.id,
          missionStatus: state.status,
          recoveryTargetStatus: state.recoveryTargetStatus,
        },
        waitJson: null,
        blockedTaskId: null,
        blockedSummary: null,
      },
    });
    if (!result.applied) {
      throw new Error(`Failed to sync mission flow for ${state.id}.`);
    }
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
  }

  function moveMissionToDone(state: ClawMissionStateRecord, currentStep: string): void {
    const flow = getFlowOrThrow(state);
    const endedAt = Date.now();
    const result = finishFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep,
      stateJson: {
        missionId: state.id,
        missionStatus: "done",
      },
      endedAt,
      updatedAt: endedAt,
    });
    if (!result.applied) {
      throw new Error(`Failed to complete mission ${state.id}.`);
    }
    state.status = "done";
    state.currentStep = currentStep;
    state.endedAt = new Date(endedAt).toISOString();
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    state.blockedSummary = null;
    state.recoveryTargetStatus = null;
  }

  function moveMissionToFailed(
    state: ClawMissionStateRecord,
    currentStep: string,
    detail?: string | null,
  ): void {
    const flow = getFlowOrThrow(state);
    const endedAt = Date.now();
    const result = failFlow({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      currentStep,
      stateJson: {
        missionId: state.id,
        missionStatus: "failed",
        detail: detail ?? null,
      },
      blockedSummary: detail ?? undefined,
      endedAt,
      updatedAt: endedAt,
    });
    if (!result.applied) {
      throw new Error(`Failed to fail mission ${state.id}.`);
    }
    state.status = "failed";
    state.currentStep = currentStep;
    state.endedAt = new Date(endedAt).toISOString();
    state.flowRevision = result.flow.revision;
    state.flowStatus = result.flow.status as ClawManagedFlowStatus;
    state.blockedSummary = detail ?? null;
    state.recoveryTargetStatus = null;
  }

  function ensureRunnerSession(state: ClawMissionStateRecord): {
    sessionId: string;
    sessionFile: string;
  } {
    if (!state.runnerSessionId) {
      state.runnerSessionId = `claw-runner-${state.id}`;
    }
    if (!state.runnerSessionFile) {
      state.runnerSessionFile = path.join(state.logsDir, "runner-session.jsonl");
    }
    return {
      sessionId: state.runnerSessionId,
      sessionFile: state.runnerSessionFile,
    };
  }

  async function persistRuntimeState(state: ClawMissionStateRecord): Promise<void> {
    state.updatedAt = isoNow(now);
    await saveMissionState(state);
    await writeDynamicMissionDocs(state);
  }

  async function attemptMissionPlanning(params: {
    state: ClawMissionStateRecord;
    cfg: OpenClawConfig;
  }): Promise<{
    plan: ClawMissionPlan;
    usedFallback: boolean;
    detail?: string | null;
  }> {
    const fallbackPlan = params.state.missionPlan;
    const sessionId = `claw-planner-${params.state.id}-${crypto.randomUUID().slice(0, 8)}`;
    const sessionFile = path.join(
      params.state.logsDir,
      `planner-${crypto.randomUUID().slice(0, 8)}.jsonl`,
    );
    await ensureSessionHeader({
      sessionFile,
      sessionId,
      cwd: params.state.workspaceDir,
    });

    try {
      const result = await runMissionAgent({
        sessionId,
        sessionFile,
        workspaceDir: params.state.workspaceDir,
        config: params.cfg,
        trigger: "manual",
        senderIsOwner: true,
        clawRole: "helper",
        prompt: buildClawPlanningPrompt({
          missionId: params.state.id,
          title: params.state.title,
          goal: params.state.goal,
          workspaceDir: params.state.workspaceDir,
        }),
        extraSystemPrompt: buildClawPlanningExtraSystemPrompt(),
        runId: buildCycleRunId("helper", params.state.id),
        timeoutMs: 120_000,
        execOverrides: {
          host: "gateway",
          security: "full",
          ask: "off",
        },
        bashElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
      });
      const plannerText = joinPayloadText(result);
      const planning = parsePlanningDecision(plannerText, fallbackPlan);
      return {
        usedFallback: false,
        plan: {
          source: "planned",
          summary: planning.summary,
          scopeIn: planning.scopeIn,
          scopeOut: planning.scopeOut,
          phases: planning.phases,
          tasks: planning.tasks,
          doneCriteria: planning.doneCriteria,
        },
        detail: plannerText || null,
      };
    } catch (error) {
      return {
        usedFallback: true,
        plan: fallbackPlan,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function executeHelperCycle(params: {
    state: ClawMissionStateRecord;
    reason: "no_progress" | "verifier_rejection";
    summary: string;
  }): Promise<void> {
    const { state } = params;
    const promptFiles = await readMissionPromptFiles(state);
    const sessionId = `claw-helper-${state.id}-${crypto.randomUUID().slice(0, 8)}`;
    const sessionFile = path.join(
      state.logsDir,
      `helper-${state.runCycleCount + state.verifyCycleCount + 1}-${crypto.randomUUID().slice(0, 8)}.jsonl`,
    );
    await ensureSessionHeader({
      sessionFile,
      sessionId,
      cwd: state.workspaceDir,
    });
    const result = await runMissionAgent({
      sessionId,
      sessionFile,
      workspaceDir: state.workspaceDir,
      config: loadClawConfig(),
      trigger: "manual",
      senderIsOwner: true,
      clawRole: "helper",
      prompt: buildClawHelperPrompt({
        missionId: state.id,
        title: state.title,
        goal: state.goal,
        currentStep: state.currentStep,
        summary: params.summary,
        reason: params.reason,
        recentEvidence: state.recentEvidence,
        files: promptFiles,
      }),
      extraSystemPrompt: buildClawHelperExtraSystemPrompt(),
      runId: buildCycleRunId("helper", state.id),
      timeoutMs: 120_000,
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "off",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
      },
    });
    const helperText = joinPayloadText(result);
    const decision = parseHelperDecision(helperText);
    state.recentEvidence = decision.evidence.length > 0 ? decision.evidence : state.recentEvidence;
    await recordAudit(state, {
      actor: "system",
      type: "mission.helperCycle",
      summary: decision.summary,
      detail: helperText || null,
    });

    if (decision.outcome === "blocked") {
      moveMissionToWaiting({
        state,
        status: "blocked",
        currentStep: "Helper session surfaced a concrete blocker.",
        waitKind: "helper_blocker",
        blockedSummary: decision.blockerSummary ?? decision.summary,
      });
      await recordAudit(state, {
        actor: "system",
        type: "mission.blocked",
        summary: decision.blockerSummary ?? decision.summary,
      });
      await persistRuntimeState(state);
      return;
    }

    state.consecutiveNoProgressCount = 0;
    state.consecutiveVerifierRejectCount = 0;
    state.lastVerifierRejectionSignature = null;
    moveMissionToRunning(
      state,
      decision.nextStep?.trim() || decision.summary || "Continue mission execution.",
    );
    await recordAudit(state, {
      actor: "system",
      type: "mission.replanned",
      summary: decision.summary,
    });
    await persistRuntimeState(state);
  }

  async function executeRunnerCycle(state: ClawMissionStateRecord): Promise<void> {
    const promptFiles = await readMissionPromptFiles(state);
    const session = ensureRunnerSession(state);
    await ensureSessionHeader({
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      cwd: state.workspaceDir,
    });
    const result = await runMissionAgent({
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      workspaceDir: state.workspaceDir,
      config: loadClawConfig(),
      trigger: "manual",
      senderIsOwner: true,
      clawRole: "runner",
      prompt: buildClawRunnerPrompt({
        missionId: state.id,
        title: state.title,
        goal: state.goal,
        status: state.status,
        currentStep: state.currentStep,
        blockedSummary: state.blockedSummary,
        recentEvidence: state.recentEvidence,
        files: promptFiles,
      }),
      extraSystemPrompt: buildClawRunnerExtraSystemPrompt(),
      runId: buildCycleRunId("runner", state.id),
      timeoutMs: 120_000,
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "off",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
      },
    });
    const runnerText = joinPayloadText(result);
    const decision = parseRunnerDecision(runnerText);
    state.runCycleCount += 1;
    state.recentEvidence = decision.evidence.length > 0 ? decision.evidence : state.recentEvidence;
    state.lastFailureSummary = null;
    state.consecutiveFailureCount = 0;
    state.currentStep = decision.currentStep;
    await recordAudit(state, {
      actor: "system",
      type: "mission.runnerCycle",
      summary: decision.summary,
      detail: runnerText || null,
    });

    if (decision.progress) {
      state.consecutiveNoProgressCount = 0;
    } else {
      state.consecutiveNoProgressCount += 1;
    }

    if (!decision.progress && state.consecutiveNoProgressCount >= CLAW_RUNNER_MAX_NO_PROGRESS) {
      await executeHelperCycle({
        state,
        reason: "no_progress",
        summary:
          decision.nextStep?.trim() || "Mission made no progress across repeated runner cycles.",
      });
      return;
    }

    if (decision.outcome === "verify") {
      moveMissionToVerifying(
        state,
        decision.nextStep?.trim() || "Run the required fresh-context verification pass.",
      );
      await recordAudit(state, {
        actor: "system",
        type: "mission.verifying",
        summary: "Mission requested a fresh verification pass.",
      });
      await persistRuntimeState(state);
      return;
    }

    if (decision.outcome === "blocked") {
      moveMissionToWaiting({
        state,
        status: "blocked",
        currentStep: decision.currentStep,
        waitKind: "runtime_blocker",
        note: decision.blockerDetail ?? null,
        blockedSummary: decision.blockerSummary ?? decision.summary,
      });
      await recordAudit(state, {
        actor: "system",
        type: "mission.blocked",
        summary: decision.blockerSummary ?? decision.summary,
        detail: decision.blockerDetail ?? null,
      });
      await persistRuntimeState(state);
      return;
    }

    if (decision.outcome === "failed") {
      moveMissionToFailed(state, decision.currentStep, decision.summary);
      await recordAudit(state, {
        actor: "system",
        type: "mission.failed",
        summary: decision.summary,
      });
      await persistRuntimeState(state);
      return;
    }

    state.currentStep = decision.nextStep?.trim() || decision.currentStep;
    if (state.status === "recovering") {
      moveMissionToRunning(state, state.currentStep);
    } else {
      syncActiveMissionFlow(state);
    }
    await persistRuntimeState(state);
  }

  async function executeVerifierCycle(state: ClawMissionStateRecord): Promise<void> {
    const promptFiles = await readMissionPromptFiles(state);
    const sessionId = `claw-verifier-${state.id}-${crypto.randomUUID().slice(0, 8)}`;
    const sessionFile = path.join(
      state.logsDir,
      `verifier-${state.verifyCycleCount + 1}-${crypto.randomUUID().slice(0, 8)}.jsonl`,
    );
    await ensureSessionHeader({
      sessionFile,
      sessionId,
      cwd: state.workspaceDir,
    });
    const result = await runMissionAgent({
      sessionId,
      sessionFile,
      workspaceDir: state.workspaceDir,
      config: loadClawConfig(),
      trigger: "manual",
      senderIsOwner: true,
      clawRole: "verifier",
      prompt: buildClawVerifierPrompt({
        missionId: state.id,
        title: state.title,
        goal: state.goal,
        currentStep: state.currentStep,
        recentEvidence: state.recentEvidence,
        files: promptFiles,
      }),
      extraSystemPrompt: buildClawVerifierExtraSystemPrompt(),
      runId: buildCycleRunId("verifier", state.id),
      timeoutMs: 120_000,
      execOverrides: {
        host: "gateway",
        security: "full",
        ask: "off",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
      },
    });
    const verifierText = joinPayloadText(result);
    const decision = parseVerifierDecision(verifierText);
    const rejectionSignature = decision.unmetCriteria.join("\n").trim() || decision.summary;
    state.verifyCycleCount += 1;
    state.recentEvidence = decision.evidence.length > 0 ? decision.evidence : state.recentEvidence;
    await recordAudit(state, {
      actor: "system",
      type: "mission.verifierCycle",
      summary: decision.summary,
      detail: verifierText || null,
    });

    if (decision.outcome === "done") {
      moveMissionToDone(state, "Mission completed and passed verification.");
      state.consecutiveVerifierRejectCount = 0;
      state.lastVerifierRejectionSignature = null;
      await recordAudit(state, {
        actor: "system",
        type: "mission.done",
        summary: "Mission passed the required verification step.",
      });
      await persistRuntimeState(state);
      return;
    }

    if (decision.outcome === "blocked") {
      moveMissionToWaiting({
        state,
        status: "blocked",
        currentStep: "Verification is blocked pending operator action.",
        waitKind: "verification_blocker",
        blockedSummary: decision.blockerSummary ?? decision.summary,
      });
      await recordAudit(state, {
        actor: "system",
        type: "mission.blocked",
        summary: decision.blockerSummary ?? decision.summary,
      });
      await persistRuntimeState(state);
      return;
    }

    if (state.lastVerifierRejectionSignature === rejectionSignature) {
      state.consecutiveVerifierRejectCount += 1;
    } else {
      state.consecutiveVerifierRejectCount = 1;
      state.lastVerifierRejectionSignature = rejectionSignature;
    }

    if (state.consecutiveVerifierRejectCount >= CLAW_VERIFIER_MAX_REJECTIONS) {
      await executeHelperCycle({
        state,
        reason: "verifier_rejection",
        summary: decision.summary,
      });
      return;
    }

    moveMissionToRunning(
      state,
      decision.nextStep?.trim() || decision.summary || "Continue the mission after verifier rejection.",
    );
    await recordAudit(state, {
      actor: "system",
      type: "mission.verifierRejected",
      summary: decision.summary,
      detail: rejectionSignature,
    });
    await persistRuntimeState(state);
  }

  async function executeMissionCycle(state: ClawMissionStateRecord): Promise<void> {
    try {
      if (state.status === "verifying") {
        await executeVerifierCycle(state);
        return;
      }
      await executeRunnerCycle(state);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      state.consecutiveFailureCount += 1;
      state.lastFailureSummary = summary;
      await recordAudit(state, {
        actor: "system",
        type: "mission.runnerError",
        summary,
      });
      if (state.consecutiveFailureCount >= CLAW_RUNNER_MAX_FAILURES) {
        moveMissionToFailed(state, "Mission failed after repeated runner errors.", summary);
        await recordAudit(state, {
          actor: "system",
          type: "mission.failed",
          summary: "Mission failed after repeated runner errors.",
          detail: summary,
        });
      } else {
        moveMissionToRunning(state, `Recover from runner error: ${summary}`);
      }
      await persistRuntimeState(state);
    }
  }

  function selectActiveMissions(
    missions: readonly ClawMissionStateRecord[],
  ): ClawMissionStateRecord[] {
    return missions
      .filter(
        (mission) =>
          mission.status === "running" ||
          mission.status === "recovering" ||
          mission.status === "verifying",
      )
      .toSorted((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  function selectQueuedMissions(
    missions: readonly ClawMissionStateRecord[],
  ): ClawMissionStateRecord[] {
    return missions
      .filter((mission) => mission.status === "queued")
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async function claimQueuedMission(queued: ClawMissionStateRecord): Promise<void> {
    moveMissionToRunning(queued, "Mission execution cycle started.");
    await recordAudit(queued, {
      actor: "system",
      type: "mission.started",
      summary: "Mission execution runner started.",
    });
    await persistRuntimeState(queued);
  }

  async function prepareMissionForCycle(
    mission: ClawMissionStateRecord,
  ): Promise<ClawMissionStateRecord> {
    if (mission.status === "recovering") {
      if (mission.recoveryTargetStatus === "verifying") {
        moveMissionToVerifying(mission, "Retrying verification after recovery.");
      } else {
        moveMissionToRunning(mission, "Mission execution resumed after recovery.");
      }
      await recordAudit(mission, {
        actor: "system",
        type: "mission.recovered",
        summary: "Mission resumed after recovery.",
      });
      await persistRuntimeState(mission);
    }
    return mission;
  }

  async function recoverInterruptedMissions(
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionDetailSnapshot | null> {
    let changedMissionId: string | null = null;
    const nowIso = isoNow(now);
    const missions = await loadAllMissionStates(workspaceDir);
    for (const mission of missions) {
      if (mission.status !== "running" && mission.status !== "verifying") {
        continue;
      }
      if (!isRecoverySafeToResumeAutomatically(mission)) {
        const summary = buildRecoveryUncertainSummary(mission);
        moveMissionToWaiting({
          state: mission,
          status: "blocked",
          currentStep: "Awaiting operator confirmation before resuming recovery.",
          waitKind: "recovery_uncertain",
          blockedSummary: summary,
        });
        ensurePendingRecoveryDecision(mission, nowIso, summary);
        await recordAudit(mission, {
          actor: "system",
          type: "decision.requested",
          summary: "Recovery continuation requires operator confirmation.",
          detail: summary,
        });
        await persistRuntimeState(mission);
        changedMissionId = mission.id;
        continue;
      }
      moveMissionToRecovering(
        mission,
        mission.status === "verifying" ? "verifying" : "running",
        "Recovering mission state after gateway restart.",
      );
      await recordAudit(mission, {
        actor: "system",
        type: "mission.recovering",
        summary: "Mission moved into recovery after gateway startup.",
      });
      await persistRuntimeState(mission);
      changedMissionId = mission.id;
    }
    if (!changedMissionId) {
      return null;
    }
    return await getMissionSnapshot(changedMissionId, workspaceDir);
  }

  async function runMissionCycles(
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionDetailSnapshot[]> {
    const clawConfig = resolveClawExecutionConfig();
    const control = await loadControlState(workspaceDir);
    await reconcileMissionStates(workspaceDir, control);
    if (!control.autonomyEnabled || control.pauseAll || control.stopAllNowRequestedAt) {
      return [];
    }

    const missions = await loadAllMissionStates(workspaceDir);
    const activeMissions = selectActiveMissions(missions);
    const queuedMissions = selectQueuedMissions(missions);
    const availableSlots = Math.max(0, clawConfig.maxActiveMissions - activeMissions.length);
    const claimedQueued = queuedMissions.slice(0, availableSlots);

    for (const queued of claimedQueued) {
      await claimQueuedMission(queued);
    }

    const cycleTargets = [...activeMissions, ...claimedQueued];
    if (cycleTargets.length === 0) {
      return [];
    }

    const snapshots: ClawMissionDetailSnapshot[] = [];
    for (const mission of cycleTargets) {
      await prepareMissionForCycle(mission);
      await executeMissionCycle(mission);
      const snapshot = await getMissionSnapshot(mission.id, workspaceDir);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  async function runNextMissionCycle(
    workspaceDir = resolveWorkspaceDir(),
  ): Promise<ClawMissionDetailSnapshot | null> {
    const snapshots = await runMissionCycles(workspaceDir);
    return snapshots[0] ?? null;
  }

  async function createMission(params: {
    goal: string;
    title?: string;
  }): Promise<ClawMissionDetailSnapshot> {
    const goal = params.goal.trim();
    if (!goal) {
      throw new Error("Mission goal is required.");
    }
    const workspaceDir = await ensureRoot(resolveWorkspaceDir());
    const createdAt = now();
    const createdAtIso = createdAt.toISOString();
    const title = normalizeTitle(params.title?.trim() || deriveMissionTitle(goal));
    const cfg = loadClawConfig();
    const missionId = buildMissionId(createdAt, title);
    const missionDir = resolveMissionDir(missionId, workspaceDir);
    const artifactsDir = path.join(missionDir, "artifacts");
    const logsDir = path.join(missionDir, "logs");
    const auditLogPath = path.join(missionDir, MISSION_AUDIT_FILENAME);

    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });

    const stateBase = {
      version: 1 as const,
      id: missionId,
      title,
      goal,
      status: "draft" as ClawMissionStatus,
      createdAt: createdAtIso,
      updatedAt: createdAtIso,
      approvedAt: null,
      startedAt: null,
      endedAt: null,
      workspaceDir,
      missionDir,
      flowId: null,
      flowRevision: null,
      flowStatus: null,
      currentStep: "Creating mission packet.",
      blockedSummary: null,
      preflight: [] as ClawPreflightCheck[],
      decisions: [] as ClawPendingDecision[],
      files: [] as ClawMissionFileEntry[],
      missionPlan: buildFallbackMissionPlan({
        title,
        goal,
      }),
      artifactsDir,
      logsDir,
      auditLogPath,
      auditCount: 0,
      runnerSessionId: null,
      runnerSessionFile: null,
      recoveryTargetStatus: null,
      recentEvidence: [] as string[],
      consecutiveFailureCount: 0,
      consecutiveNoProgressCount: 0,
      consecutiveVerifierRejectCount: 0,
      lastFailureSummary: null,
      lastVerifierRejectionSignature: null,
      runCycleCount: 0,
      verifyCycleCount: 0,
    };

    const state: ClawMissionStateRecord = {
      ...stateBase,
      files: [],
    };

    state.files = missionFilesForState(state);
    await saveMissionState(state);
    await writeStaticMissionDocs(state);
    await writeDynamicMissionDocs(state);
    await recordAudit(state, {
      actor: "system",
      type: "mission.created",
      summary: "Mission packet created from the requested goal.",
    });
    if (cfg.claw?.enabled === true) {
      const planningAttempt = await attemptMissionPlanning({ state, cfg });
      state.missionPlan = planningAttempt.plan;
      await saveMissionState(state);
      await writeStaticMissionDocs(state);
      await writeDynamicMissionDocs(state);
      await recordAudit(state, {
        actor: "system",
        type: planningAttempt.usedFallback ? "mission.packetFallback" : "mission.packetPlanned",
        summary: planningAttempt.usedFallback
          ? "Mission packet planning fell back to the deterministic goal-derived packet."
          : "Mission packet planning completed successfully.",
        detail: planningAttempt.detail ?? null,
      });
    }
    state.status = "preflighting";
    state.currentStep = "Running mission preflight checks.";
    await saveMissionState(state);
    await writeDynamicMissionDocs(state);
    await recordAudit(state, {
      actor: "system",
      type: "mission.preflighting",
      summary: "Mission preflight started.",
    });

    const preflight = await buildPreflightChecks({
      goal,
      workspaceDir,
      missionDir,
      cfg,
      inspectBrowserReadiness,
    });
    const awaitingSetup = hasBlockingPreflight(preflight);
    const blockedSummary = summarizeBlockingPreflight(preflight);
    state.preflight = preflight;
    state.blockedSummary = blockedSummary;
    state.status = awaitingSetup ? "awaiting_setup" : "awaiting_approval";
    state.currentStep = awaitingSetup
      ? "Resolve preflight blockers before mission approval."
      : "Awaiting mission start approval.";
    state.decisions = awaitingSetup
      ? [buildPreflightDecision(createdAtIso, blockedSummary ?? "Resolve preflight blockers.")]
      : [buildStartApprovalDecision(createdAtIso)];

    const flow = createManagedTaskFlow({
      ownerKey: `claw:${missionId}`,
      controllerId: "claw/mission",
      status: awaitingSetup ? "blocked" : "waiting",
      goal,
      currentStep: state.currentStep,
      stateJson: {
        missionId,
        missionStatus: state.status,
      },
      waitJson: {
        kind: awaitingSetup ? "preflight_setup" : "approval",
      },
      blockedSummary: blockedSummary ?? undefined,
    });
    state.flowId = flow.flowId;
    state.flowRevision = flow.revision;
    state.flowStatus = flow.status as ClawManagedFlowStatus;
    state.files = missionFilesForState(state);

    await recordAudit(state, {
      actor: "system",
      type: "decision.requested",
      summary: awaitingSetup
        ? "Preflight blockers were detected and require operator attention."
        : "Mission start approval requested.",
    });
    await saveMissionState(state);
    await writeDynamicMissionDocs(state);
    return await getMissionSnapshot(missionId, workspaceDir);
  }

  async function approveMissionStart(missionId: string): Promise<ClawMissionDetailSnapshot> {
    return await updateMission(missionId, async (state) => {
      const control = await loadControlState(state.workspaceDir);
      requireMissionStatus(state, ["awaiting_approval"], "approve");
      const approval = resolveStartDecision(state);
      if (!approval) {
        throw new Error(`Mission ${missionId} does not have a pending start approval.`);
      }
      approval.status = "resolved";
      approval.response = {
        action: "approve",
        respondedAt: isoNow(now),
      };
      state.approvedAt = state.approvedAt ?? isoNow(now);
      moveMissionToQueued(state, resolveQueuedCurrentStep(control));
      await recordAudit(state, {
        actor: "operator",
        type: "decision.resolved",
        summary: "Mission start approved.",
      });
      return state;
    });
  }

  async function pauseMission(
    missionId: string,
    note?: string,
  ): Promise<ClawMissionDetailSnapshot> {
    return await updateMission(missionId, async (state) => {
      if (!canPauseMissionStatus(state.status)) {
        throw new Error(`Cannot pause mission from status "${state.status}".`);
      }
      moveMissionToWaiting({
        state,
        status: "paused",
        currentStep: "Paused by operator.",
        waitKind: "paused",
        note: note ?? null,
      });
      await recordAudit(state, {
        actor: "operator",
        type: "mission.paused",
        summary: "Mission paused.",
        detail: note ?? null,
      });
      return state;
    });
  }

  async function resumeMission(missionId: string): Promise<ClawMissionDetailSnapshot> {
    return await updateMission(missionId, async (state) => {
      const control = await loadControlState(state.workspaceDir);
      if (resolvePendingDecisionByKind(state, "recovery_uncertain")) {
        throw new Error(
          "Cannot resume mission while recovery uncertainty is awaiting operator confirmation.",
        );
      }
      requireMissionStatus(state, ["paused", "blocked"], "resume");
      moveMissionToQueued(state, resolveQueuedCurrentStep(control));
      await recordAudit(state, {
        actor: "operator",
        type: "mission.resumed",
        summary: "Mission resumed.",
      });
      return state;
    });
  }

  async function cancelMission(
    missionId: string,
    note?: string,
  ): Promise<ClawMissionDetailSnapshot> {
    return await updateMission(missionId, async (state) => {
      if (isTerminalMissionStatus(state.status)) {
        throw new Error(`Cannot cancel mission from status "${state.status}".`);
      }
      const flow = getFlowOrThrow(state);
      const cancelledAt = Date.now();
      const cancelled = updateFlowRecordByIdExpectedRevision({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        patch: {
          status: "cancelled",
          currentStep: "Cancelled by operator.",
          stateJson: {
            missionId: state.id,
            missionStatus: "cancelled",
          },
          waitJson: null,
          endedAt: cancelledAt,
          updatedAt: cancelledAt,
        },
      });
      if (!cancelled.applied) {
        throw new Error(`Failed to cancel mission ${missionId}.`);
      }
      resolveAllPendingDecisions(state, "cancel", isoNow(now), note ?? null);
      state.status = "cancelled";
      state.currentStep = "Cancelled by operator.";
      state.endedAt = isoNow(now);
      state.flowRevision = cancelled.flow.revision;
      state.flowStatus = cancelled.flow.status as ClawManagedFlowStatus;
      await recordAudit(state, {
        actor: "operator",
        type: "mission.cancelled",
        summary: "Mission cancelled.",
        detail: note ?? null,
      });
      return state;
    });
  }

  async function replyDecision(params: {
    missionId: string;
    decisionId: string;
    action: ClawDecisionAction;
    note?: string;
  }): Promise<ClawMissionDetailSnapshot> {
    return await updateMission(params.missionId, async (state) => {
      const decision = resolvePendingDecision(state, params.decisionId);
      if (!decision) {
        throw new Error(`Unknown decision: ${params.decisionId}`);
      }
      if (decision.status !== "pending") {
        throw new Error(`Decision ${params.decisionId} has already been resolved.`);
      }
      if (decision.kind === "start_approval" && params.action === "approve") {
        const control = await loadControlState(state.workspaceDir);
        requireMissionStatus(state, ["awaiting_approval"], "approve");
        decision.status = "resolved";
        decision.response = {
          action: "approve",
          note: params.note ?? null,
          respondedAt: isoNow(now),
        };
        state.approvedAt = state.approvedAt ?? isoNow(now);
        moveMissionToQueued(state, resolveQueuedCurrentStep(control));
        await recordAudit(state, {
          actor: "operator",
          type: "decision.resolved",
          summary: "Mission start approved.",
        });
        return state;
      }
      if (decision.kind === "recovery_uncertain" && params.action === "continue") {
        const control = await loadControlState(state.workspaceDir);
        requireMissionStatus(state, ["blocked", "recovering"], "continue");
        decision.status = "resolved";
        decision.response = {
          action: "continue",
          note: params.note ?? null,
          respondedAt: isoNow(now),
        };
        moveMissionToQueued(
          state,
          shouldStartMissionImmediately(control)
            ? "Queued after operator confirmed recovery continuation."
            : resolveQueuedCurrentStep(control),
        );
        await recordAudit(state, {
          actor: "operator",
          type: "decision.resolved",
          summary: "Recovery continuation approved.",
          detail: params.note ?? null,
        });
        return state;
      }
      if (params.action === "cancel" || params.action === "reject") {
        if (isTerminalMissionStatus(state.status)) {
          throw new Error(`Cannot cancel mission from status "${state.status}".`);
        }
        resolveAllPendingDecisions(state, params.action, isoNow(now), params.note ?? null);
        const flow = getFlowOrThrow(state);
        const cancelledAt = Date.now();
        const cancelled = updateFlowRecordByIdExpectedRevision({
          flowId: flow.flowId,
          expectedRevision: flow.revision,
          patch: {
            status: "cancelled",
            currentStep: "Cancelled by operator.",
            stateJson: {
              missionId: state.id,
              missionStatus: "cancelled",
            },
            waitJson: null,
            endedAt: cancelledAt,
            updatedAt: cancelledAt,
          },
        });
        if (!cancelled.applied) {
          throw new Error(`Failed to cancel mission ${params.missionId}.`);
        }
        state.status = "cancelled";
        state.currentStep = "Cancelled by operator.";
        state.endedAt = isoNow(now);
        state.flowRevision = cancelled.flow.revision;
        state.flowStatus = cancelled.flow.status as ClawManagedFlowStatus;
        await recordAudit(state, {
          actor: "operator",
          type: "mission.cancelled",
          summary: "Mission cancelled.",
          detail: params.note ?? null,
        });
        return state;
      }
      if (params.action === "pause") {
        if (!canPauseMissionStatus(state.status)) {
          throw new Error(`Cannot pause mission from status "${state.status}".`);
        }
        decision.status = "resolved";
        decision.response = {
          action: "pause",
          note: params.note ?? null,
          respondedAt: isoNow(now),
        };
        moveMissionToWaiting({
          state,
          status: "paused",
          currentStep: "Paused by operator.",
          waitKind: "paused",
          note: params.note ?? null,
        });
        await recordAudit(state, {
          actor: "operator",
          type: "mission.paused",
          summary: "Mission paused.",
          detail: params.note ?? null,
        });
        return state;
      }
      decision.status = "resolved";
      decision.response = {
        action: params.action,
        note: params.note ?? null,
        respondedAt: isoNow(now),
      };
      await recordAudit(state, {
        actor: "operator",
        type: "decision.resolved",
        summary: `Decision resolved with action "${params.action}".`,
        detail: params.note ?? null,
      });
      return state;
    });
  }

  async function rerunPreflight(missionId: string): Promise<ClawMissionDetailSnapshot> {
    return await updateMission(missionId, async (state) => {
      const cfg = loadClawConfig();
      state.preflight = await buildPreflightChecks({
        goal: state.goal,
        workspaceDir: state.workspaceDir,
        missionDir: state.missionDir,
        cfg,
        inspectBrowserReadiness,
      });
      const nowIso = isoNow(now);
      const blockingSummary = summarizeBlockingPreflight(state.preflight);
      if (!blockingSummary) {
        moveMissionToWaiting({
          state,
          status: "awaiting_approval",
          currentStep: "Awaiting mission start approval.",
          waitKind: "approval",
        });
        resolvePendingDecisionByKindWithContinue(
          state,
          "preflight_blocker",
          nowIso,
          "Preflight reran without blockers.",
        );
        ensurePendingStartDecision(state, nowIso);
      } else {
        moveMissionToWaiting({
          state,
          status: "awaiting_setup",
          currentStep: "Resolve preflight blockers before mission approval.",
          waitKind: "preflight_setup",
          blockedSummary: blockingSummary,
        });
        ensurePendingPreflightDecision(state, nowIso, blockingSummary);
      }
      await recordAudit(state, {
        actor: "operator",
        type: "preflight.rerun",
        summary: "Mission preflight re-ran.",
      });
      return state;
    });
  }

  async function listArtifacts(missionId: string): Promise<ClawArtifactEntry[]> {
    const mission = await loadMissionState(missionId);
    if (!mission) {
      throw new Error(`Unknown mission: ${missionId}`);
    }
    return await listArtifactEntriesForState(mission);
  }

  async function getAudit(missionId: string, limit?: number): Promise<ClawAuditEntry[]> {
    const mission = await loadMissionState(missionId);
    if (!mission) {
      throw new Error(`Unknown mission: ${missionId}`);
    }
    if (!(await fileExists(mission.auditLogPath))) {
      return [];
    }
    const raw = await fs.readFile(mission.auditLogPath, "utf-8");
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ClawAuditEntry)
      .toSorted((left, right) => right.at.localeCompare(left.at));
    if (typeof limit === "number" && limit > 0) {
      return entries.slice(0, limit);
    }
    return entries;
  }

  async function pauseAll(enabled = true): Promise<ClawControlState> {
    const workspaceDir = resolveWorkspaceDir();
    const control = await loadControlState(workspaceDir);
    const next = await saveControlState({
      ...control,
      pauseAll: enabled,
      stopAllNowRequestedAt: enabled ? control.stopAllNowRequestedAt ?? null : null,
      updatedAt: isoNow(now),
    });
    await reconcileMissionStates(workspaceDir, next);
    return next;
  }

  async function stopAllNow(): Promise<ClawControlState> {
    const workspaceDir = resolveWorkspaceDir();
    const control = await loadControlState(workspaceDir);
    const next = await saveControlState({
      ...control,
      pauseAll: true,
      stopAllNowRequestedAt: isoNow(now),
      updatedAt: isoNow(now),
    });
    await reconcileMissionStates(workspaceDir, next);
    return next;
  }

  async function setAutonomy(enabled: boolean): Promise<ClawControlState> {
    const workspaceDir = resolveWorkspaceDir();
    const control = await loadControlState(workspaceDir);
    const next = await saveControlState({
      ...control,
      autonomyEnabled: enabled,
      updatedAt: isoNow(now),
    });
    await reconcileMissionStates(workspaceDir, next);
    return next;
  }

  return {
    resolveWorkspaceDir,
    resolveMissionsRoot,
    buildDashboard,
    getMissionSnapshot,
    createMission,
    approveMissionStart,
    pauseMission,
    resumeMission,
    cancelMission,
    replyDecision,
    rerunPreflight,
    listArtifacts,
    getAudit,
    recoverInterruptedMissions,
    runMissionCycles,
    runNextMissionCycle,
    loadControlState,
    pauseAll,
    stopAllNow,
    setAutonomy,
  };
}

export const clawMissionService = createClawMissionService();
