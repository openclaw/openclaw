import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveSessionStoreEntry } from "../config/sessions/store.js";
import { resolveSessionFilePath, resolveStorePath } from "../config/sessions/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";
import {
  syncInboundReceiptFromChiefTask,
  type InboundReceiptContinuityDecision,
} from "./inbound-receipt-ledger.js";
import {
  buildPaperclipTrackedIssueDescription,
  ensurePaperclipTrackedIssue,
  isPaperclipIssueRunOwnershipConflictError,
  isPaperclipIssueNotFoundError,
  isPaperclipRunIdRequiredError,
  updatePaperclipTrackedIssue,
  type PaperclipIssueStatus,
} from "./paperclip-issues.js";

export const CHIEF_TASK_LEDGER_VERSION = 5;
export const CHIEF_TASK_LEDGER_ARCHIVE_VERSION = 1;
export const CHIEF_TASK_STALE_AFTER_MS = 5 * 60_000;
export const CHIEF_TASK_RESUME_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_CHIEF_TASK_LEDGER_ARCHIVE_RETENTION_DAYS = 30;
const CHIEF_TASK_LEDGER_FILENAME = "chief-task-ledger.json";
const CHIEF_TASK_LEDGER_ARCHIVE_FILENAME = "chief-task-ledger.archive.json";
const CHIEF_RUNTIME_STATE_FILENAME = "chief-runtime-state.json";
const CHIEF_CONTINUATION_PROMPT_PREFIX =
  "Resume the unfinished task below and continue it until it is finished, blocked, or clearly awaiting user input.";

export type ChiefTaskStatus =
  | "in_progress"
  | "stalled"
  | "awaiting_input"
  | "blocked"
  | "done";

export type ChiefTaskSource = "telegram" | "paperclip" | "direct" | "internal" | "unknown";

export type ChiefTaskPhase =
  | "queued"
  | "triaged"
  | "delegated"
  | "executing"
  | "reviewing"
  | "awaiting_input"
  | "blocked"
  | "done";

export type ChiefTaskContainer = "ephemeral_internal" | "durable_local" | "paperclip_issue";

export type ChiefTaskRiskLevel = "low" | "medium" | "high" | "critical";

export type ChiefTaskReleaseGateStatus =
  | "not_required"
  | "required"
  | "reviewing"
  | "passed"
  | "blocked";

export type ChiefTaskHeadlineKind = "goal" | "intent" | "success" | "title" | "request";

export type ChiefTaskContinuityEvent = {
  at: number;
  decision: InboundReceiptContinuityDecision;
  receiptId?: string;
  sourceMessageId?: string;
};

export type ChiefTaskRecord = {
  taskId: string;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  status: ChiefTaskStatus;
  phase: ChiefTaskPhase;
  container: ChiefTaskContainer;
  source: ChiefTaskSource;
  title: string;
  promptPreview: string;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  activeAgents: string[];
  currentOwner: string;
  receiptId?: string;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  programId?: string;
  parentTaskId?: string;
  role?: string;
  threadKey?: string;
  openIntentKey?: string;
  intentSummary?: string;
  currentGoal?: string;
  successCriteria?: string;
  taskHeadline?: string;
  taskHeadlineKind?: ChiefTaskHeadlineKind;
  verificationEvidence?: string[];
  riskLevel?: ChiefTaskRiskLevel;
  confidence?: number;
  latestMilestone?: string;
  lastUserProgressReportAt?: number;
  releaseGateStatus?: ChiefTaskReleaseGateStatus;
  paperclipRunId?: string;
  syncDriftReason?: string;
  continuityDecision?: InboundReceiptContinuityDecision;
  createdByApproval?: boolean;
  continuityHistory?: ChiefTaskContinuityEvent[];
  legacyLocalTerminal?: boolean;
  lastResponsePreview?: string;
  lastError?: string;
  runAttempts: number;
  resumeAttempts: number;
  recoveryCount: number;
  fallbackStage: string;
  lastRecoveryAction?: string;
  lastFallbackAction?: string;
  lastCompactionCause?: string;
  nextStep?: string;
  lastResumeRequestedAt?: number;
  completedAt?: number;
};

type ChiefTaskLedger = {
  version: number;
  activeBySessionKey: Record<string, string>;
  tasks: Record<string, ChiefTaskRecord>;
};

export type ChiefTaskLedgerArchiveEntry = {
  task: ChiefTaskRecord;
  archivedAt: number;
  archiveReason: "legacy_local_terminal_retention";
};

export type ChiefTaskLedgerArchive = {
  version: number;
  archiveLastRunAt?: number;
  archiveLastOutcome?: string;
  archiveRetentionDays?: number;
  archivedTasks: Record<string, ChiefTaskLedgerArchiveEntry>;
};

export type ChiefTaskLedgerArchiveResult = {
  archivePath: string;
  archivedTaskIds: string[];
  archivedLegacyTerminalCount: number;
  retainedLegacyLocalTerminalCount: number;
  archiveLastRunAt: number;
  archiveLastOutcome: string;
  ledger: ChiefTaskLedger;
  archive: ChiefTaskLedgerArchive;
};

export type ChiefTaskRuntimeSummary = {
  taskId: string;
  sessionKey: string;
  sessionId?: string;
  status: ChiefTaskStatus;
  phase: ChiefTaskPhase;
  container: ChiefTaskContainer;
  source: ChiefTaskSource;
  title: string;
  promptPreview: string;
  activeAgents: string[];
  currentOwner: string;
  receiptId?: string;
  paperclipIssueId?: string;
  programId?: string;
  parentTaskId?: string;
  role?: string;
  lastProgressAt: number;
  staleForMs: number;
  recoveryCount: number;
  fallbackStage: string;
  lastRecoveryAction?: string;
  lastFallbackAction?: string;
  lastCompactionCause?: string;
  lastError?: string;
  successCriteria?: string;
  verificationEvidence?: string[];
  riskLevel?: ChiefTaskRiskLevel;
  confidence?: number;
  latestMilestone?: string;
  lastUserProgressReportAt?: number;
  releaseGateStatus?: ChiefTaskReleaseGateStatus;
  nextStep?: string;
};

export type ChiefRuntimeState = {
  version: number;
  generatedAt: number;
  activeTaskCount: number;
  stalledTaskCount: number;
  activeTask?: ChiefTaskRuntimeSummary;
  activeTasks: ChiefTaskRuntimeSummary[];
  lastRecovery?: {
    taskId: string;
    at: number;
    action: string;
    fallbackStage: string;
    recoveryCount: number;
  };
};

type ReplyLike = {
  text?: string;
  isError?: boolean;
  mediaUrls?: string[];
};

const CONTINUITY_DECISION_STRENGTH: Record<InboundReceiptContinuityDecision, number> = {
  direct_answer: 0,
  attach_existing_task: 1,
  new_task_candidate: 2,
};

const withChiefTaskLedgerLock = createAsyncLock();

function isChiefAgentId(agentId?: string): boolean {
  return typeof agentId === "string" && agentId.trim().toLowerCase() === "chief";
}

function normalizePreview(value: string | undefined, maxChars = 280): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeThreadKey(value: string | undefined, sessionKey?: string): string | undefined {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }
  const sessionTrimmed = sessionKey?.trim();
  return sessionTrimmed || undefined;
}

function normalizeProgramId(value: string | undefined, fallback?: string): string | undefined {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed.slice(0, 200);
  }
  const fallbackTrimmed = fallback?.trim();
  return fallbackTrimmed ? fallbackTrimmed.slice(0, 200) : undefined;
}

function normalizeConfidence(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeRiskLevel(value: string | undefined): ChiefTaskRiskLevel | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return undefined;
}

function normalizeReleaseGateStatus(value: string | undefined): ChiefTaskReleaseGateStatus | undefined {
  if (
    value === "not_required" ||
    value === "required" ||
    value === "reviewing" ||
    value === "passed" ||
    value === "blocked"
  ) {
    return value;
  }
  return undefined;
}

function normalizeVerificationEvidence(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const next = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 24);
  return next.length > 0 ? next : undefined;
}

function resolveReleaseGateRequired(cfg: OpenClawConfig): boolean {
  return cfg.agents?.defaults?.releaseGateRequired !== false;
}

function normalizeContinuityHistory(
  value: ChiefTaskContinuityEvent[] | undefined,
): ChiefTaskContinuityEvent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const next = value
    .map((entry) => ({
      at:
        typeof entry?.at === "number" && Number.isFinite(entry.at) ? entry.at : Date.now(),
      decision:
        entry?.decision === "direct_answer" ||
        entry?.decision === "attach_existing_task" ||
        entry?.decision === "new_task_candidate"
          ? entry.decision
          : "attach_existing_task",
      receiptId: entry?.receiptId?.trim() || undefined,
      sourceMessageId: entry?.sourceMessageId?.trim() || undefined,
    }))
    .slice(-12);
  return next.length > 0 ? next : undefined;
}

function normalizeTitle(prompt: string): string {
  return normalizePreview(prompt, 120) ?? "Chief task";
}

function deriveTaskContainer(source: ChiefTaskSource, paperclipIssueId?: string): ChiefTaskContainer {
  if (paperclipIssueId || source === "paperclip") {
    return "paperclip_issue";
  }
  if (source === "internal") {
    return "ephemeral_internal";
  }
  return "durable_local";
}

function derivePhaseFromStatus(status: ChiefTaskStatus): ChiefTaskPhase {
  switch (status) {
    case "awaiting_input":
      return "awaiting_input";
    case "blocked":
    case "stalled":
      return "blocked";
    case "done":
      return "done";
    case "in_progress":
    default:
      return "executing";
  }
}

function isLegacyLocalTerminalTask(task: Pick<ChiefTaskRecord, "status" | "source" | "paperclipIssueId">): boolean {
  return task.status === "done" && requiresPaperclipTaskAuthority(task.source) && !task.paperclipIssueId;
}

function shouldTrackChiefRuntimeTask(task: ChiefTaskRecord): boolean {
  if (task.container === "ephemeral_internal") {
    return false;
  }
  if (task.source === "internal" && !task.receiptId?.trim() && !task.paperclipIssueId?.trim()) {
    return false;
  }
  return true;
}

function requiresPaperclipTaskAuthority(source: ChiefTaskSource): boolean {
  return source !== "internal";
}

function derivePaperclipOriginChannel(source: ChiefTaskSource): "telegram" | "paperclip" | "direct" {
  if (source === "paperclip") {
    return "paperclip";
  }
  if (source === "telegram") {
    return "telegram";
  }
  return "direct";
}

function isSilentChiefNoReplyText(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const normalized =
    trimmed.startsWith("`") && trimmed.endsWith("`") && trimmed.length > 2
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return normalized === "NO_REPLY";
}

function isSilentChiefNoReplyPayloads(payloads: ReplyLike[]): boolean {
  const texts = payloads
    .map((payload) => (typeof payload.text === "string" ? payload.text.trim() : ""))
    .filter(Boolean);
  return texts.length > 0 && texts.every((text) => isSilentChiefNoReplyText(text));
}

function resolveChiefTaskHeadlineFromFields(fields: {
  currentGoal?: string;
  intentSummary?: string;
  successCriteria?: string;
  title?: string;
  promptPreview?: string;
}): { kind: ChiefTaskHeadlineKind; text: string } {
  const candidates: Array<{ kind: ChiefTaskHeadlineKind; value?: string; maxLength: number }> = [
    { kind: "goal", value: fields.currentGoal, maxLength: 220 },
    { kind: "intent", value: fields.intentSummary, maxLength: 220 },
    { kind: "success", value: fields.successCriteria, maxLength: 280 },
    { kind: "title", value: fields.title, maxLength: 180 },
    { kind: "request", value: fields.promptPreview, maxLength: 220 },
  ];
  for (const candidate of candidates) {
    const normalized = normalizePreview(candidate.value, candidate.maxLength);
    if (normalized) {
      return { kind: candidate.kind, text: normalized };
    }
  }
  return { kind: "title", text: "Chief task" };
}

export function resolveChiefTaskHeadline(
  task: Pick<ChiefTaskRecord, "currentGoal" | "intentSummary" | "successCriteria" | "title" | "promptPreview">,
): { kind: ChiefTaskHeadlineKind; text: string } {
  return resolveChiefTaskHeadlineFromFields(task);
}

function mapChiefTaskStatusToPaperclipStatus(task: ChiefTaskRecord): PaperclipIssueStatus {
  if (task.status === "done") {
    return "done";
  }
  if (task.status === "blocked" || task.status === "awaiting_input") {
    return "blocked";
  }
  return "in_progress";
}

function buildPaperclipIssueComment(task: ChiefTaskRecord): string | undefined {
  const headline = resolveChiefTaskHeadline(task);
  const details = [
    `Task ${headline.kind}: ${headline.text}`,
    task.latestMilestone ? `Latest milestone: ${task.latestMilestone}` : undefined,
    task.nextStep ? `Next step: ${task.nextStep}` : undefined,
    task.releaseGateStatus ? `Release gate: ${task.releaseGateStatus}` : undefined,
    task.syncDriftReason ? `Sync drift: ${task.syncDriftReason}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  if (task.status === "done" && task.lastResponsePreview) {
    return `Chief completed this task.\n\n${details}\n\nLatest response:\n${task.lastResponsePreview}`.trim();
  }
  if (task.status === "awaiting_input" && task.lastResponsePreview) {
    return `Chief is waiting for user input.\n\n${details}\n\nLatest response:\n${task.lastResponsePreview}`.trim();
  }
  if (task.status === "blocked" && task.lastError) {
    return `Chief marked this task blocked.\n\n${details}\n\nReason:\n${task.lastError}`.trim();
  }
  if (task.status === "stalled" && task.lastError) {
    return `Chief hit a runtime stall and recovery is required.\n\n${details}\n\nLast error:\n${task.lastError}`.trim();
  }
  return undefined;
}

function buildPaperclipIssueDescriptionFromTask(task: ChiefTaskRecord): string {
  return buildPaperclipTrackedIssueDescription({
    receiptId: task.receiptId ?? `chief-authority:${task.taskId}`,
    bodyText: task.promptPreview,
    programId: task.programId,
    parentTaskId: task.parentTaskId,
    role: task.role,
    threadKey: task.threadKey,
    openIntentKey: task.openIntentKey,
    intentSummary: task.intentSummary,
    successCriteria: task.successCriteria,
    riskLevel: task.riskLevel,
    confidence: task.confidence,
    releaseGateStatus: task.releaseGateStatus,
    phase: task.phase,
    currentOwner: task.currentOwner,
    activeAgents: task.activeAgents,
    latestMilestone: task.latestMilestone,
    nextStep: task.nextStep,
    verificationEvidence: task.verificationEvidence,
    originChannel: derivePaperclipOriginChannel(task.source),
    originMessageId: task.sourceMessageId,
    createdByApproval: task.createdByApproval,
  });
}

async function ensureChiefTaskAuthority(params: {
  source: ChiefTaskSource;
  paperclipIssueId?: string;
  receiptId?: string;
  prompt: string;
  title?: string;
  programId?: string;
  parentTaskId?: string;
  role?: string;
  threadKey?: string;
  openIntentKey?: string;
  intentSummary?: string;
  successCriteria?: string;
  riskLevel?: ChiefTaskRiskLevel;
  confidence?: number;
  releaseGateStatus?: ChiefTaskReleaseGateStatus;
  phase?: ChiefTaskPhase;
  currentOwner?: string;
  activeAgents?: string[];
  latestMilestone?: string;
  nextStep?: string;
  verificationEvidence?: string[];
  sourceMessageId?: string;
  createdByApproval?: boolean;
  paperclipRunId?: string;
}): Promise<string | undefined> {
  const existingId = params.paperclipIssueId?.trim();
  if (existingId) {
    return existingId;
  }
  if (!requiresPaperclipTaskAuthority(params.source)) {
    return undefined;
  }
  const receiptId = params.receiptId?.trim() || `chief-authority:${randomUUID()}`;
  const title = normalizeTitle(params.title || params.prompt);
  const description = buildPaperclipTrackedIssueDescription({
    receiptId,
    bodyText: params.prompt,
    programId: params.programId,
    parentTaskId: params.parentTaskId,
    role: params.role,
    threadKey: params.threadKey,
    openIntentKey: params.openIntentKey,
    intentSummary: params.intentSummary,
    successCriteria: params.successCriteria,
    riskLevel: params.riskLevel,
    confidence: params.confidence,
    releaseGateStatus: params.releaseGateStatus,
    phase: params.phase,
    currentOwner: params.currentOwner,
    activeAgents: params.activeAgents,
    latestMilestone: params.latestMilestone,
    nextStep: params.nextStep,
    verificationEvidence: params.verificationEvidence,
    originChannel: derivePaperclipOriginChannel(params.source),
    originMessageId: params.sourceMessageId,
    createdByApproval: params.createdByApproval,
  });
  const created = await ensurePaperclipTrackedIssue({
    title,
    description,
    status: "todo",
    runId: params.paperclipRunId,
  });
  return created.id;
}

function shouldSyncPaperclipIssueForTask(task: ChiefTaskRecord): boolean {
  if (!task.paperclipIssueId?.trim() || !requiresPaperclipTaskAuthority(task.source)) {
    return false;
  }
  if (task.source === "paperclip") {
    return false;
  }
  return (
    task.status === "done" ||
    task.status === "blocked" ||
    task.status === "awaiting_input" ||
    task.phase === "reviewing"
  );
}

type PaperclipSyncOutcome = {
  ok: boolean;
  driftReason?: string;
  issueMissing?: boolean;
};

async function syncPaperclipIssueForTask(task: ChiefTaskRecord): Promise<PaperclipSyncOutcome> {
  const issueId = task.paperclipIssueId?.trim();
  if (!issueId || !shouldSyncPaperclipIssueForTask(task)) {
    return { ok: true };
  }
  try {
    await updatePaperclipTrackedIssue({
      issueId,
      status: mapChiefTaskStatusToPaperclipStatus(task),
      description: buildPaperclipIssueDescriptionFromTask(task),
      comment: buildPaperclipIssueComment(task),
      runId: task.paperclipRunId,
    });
    return { ok: true };
  } catch (error) {
    if (isPaperclipRunIdRequiredError(error)) {
      return {
        ok: false,
        driftReason:
          "paperclip terminal sync requires X-Paperclip-Run-Id; local task was terminalized but remote issue still needs sync",
      };
    }
    if (isPaperclipIssueNotFoundError(error)) {
      return {
        ok: false,
        issueMissing: true,
        driftReason: "paperclip authority issue is missing remotely; local task is keeping the last known issue id",
      };
    }
    if (isPaperclipIssueRunOwnershipConflictError(error)) {
      return {
        ok: false,
        driftReason:
          "paperclip terminal sync hit an issue run ownership conflict; local task is terminal but the remote issue still belongs to another run",
      };
    }
    throw error;
  }
}

function applyPaperclipSyncOutcome(
  task: ChiefTaskRecord,
  outcome: PaperclipSyncOutcome | undefined,
): ChiefTaskRecord {
  if (!outcome || outcome.ok) {
    if (!task.syncDriftReason) {
      return task;
    }
    return {
      ...task,
      syncDriftReason: undefined,
    };
  }
  return {
    ...task,
    syncDriftReason: outcome.driftReason,
  };
}

function isContinuableTaskStatus(status: ChiefTaskStatus): boolean {
  return status !== "done";
}

function createEmptyLedger(): ChiefTaskLedger {
  return {
    version: CHIEF_TASK_LEDGER_VERSION,
    activeBySessionKey: {},
    tasks: {},
  };
}

function createEmptyArchive(): ChiefTaskLedgerArchive {
  return {
    version: CHIEF_TASK_LEDGER_ARCHIVE_VERSION,
    archivedTasks: {},
  };
}

function normalizeTaskRecord(taskId: string, task: ChiefTaskRecord): ChiefTaskRecord {
  const source = task.source ?? "unknown";
  const paperclipIssueId = task.paperclipIssueId;
  const status = task.status ?? "in_progress";
  const derivedPhase = derivePhaseFromStatus(status);
  const phase =
    status === "done" ||
    status === "blocked" ||
    status === "stalled" ||
    status === "awaiting_input"
      ? derivedPhase
      : task.phase ?? derivedPhase;
  const activeAgents = Array.isArray(task.activeAgents)
    ? task.activeAgents
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean)
    : [];
  const headline = resolveChiefTaskHeadlineFromFields(task);
  return {
    ...task,
    taskId: task.taskId || taskId,
    source,
    status,
    phase,
    container: task.container ?? deriveTaskContainer(source, paperclipIssueId),
    activeAgents: activeAgents.length > 0 ? activeAgents : ["chief"],
    currentOwner: task.currentOwner?.trim() || "chief",
    recoveryCount:
      typeof task.recoveryCount === "number" && Number.isFinite(task.recoveryCount)
        ? task.recoveryCount
        : 0,
    programId: normalizeProgramId(task.programId, task.sessionKey),
    parentTaskId: task.parentTaskId?.trim() || undefined,
    role: normalizePreview(task.role, 80),
    fallbackStage: task.fallbackStage?.trim() || "none",
    receiptId: task.receiptId?.trim() || undefined,
    sessionId: task.sessionId?.trim() || undefined,
    threadKey: normalizeThreadKey(task.threadKey, task.sessionKey),
    openIntentKey: normalizePreview(task.openIntentKey, 160),
    intentSummary: normalizePreview(task.intentSummary, 220),
    currentGoal: normalizePreview(task.currentGoal, 220),
    successCriteria: normalizePreview(task.successCriteria, 280),
    taskHeadline: normalizePreview(task.taskHeadline, 280) ?? headline.text,
    taskHeadlineKind:
      task.taskHeadlineKind === "goal" ||
      task.taskHeadlineKind === "intent" ||
      task.taskHeadlineKind === "success" ||
      task.taskHeadlineKind === "title" ||
      task.taskHeadlineKind === "request"
        ? task.taskHeadlineKind
        : headline.kind,
    verificationEvidence: normalizeVerificationEvidence(task.verificationEvidence),
    riskLevel: normalizeRiskLevel(task.riskLevel),
    confidence: normalizeConfidence(task.confidence),
    latestMilestone: normalizePreview(task.latestMilestone, 220),
    lastUserProgressReportAt:
      typeof task.lastUserProgressReportAt === "number" &&
      Number.isFinite(task.lastUserProgressReportAt)
        ? task.lastUserProgressReportAt
        : undefined,
    releaseGateStatus: normalizeReleaseGateStatus(task.releaseGateStatus),
    paperclipRunId: normalizePreview(task.paperclipRunId, 160),
    syncDriftReason: normalizePreview(task.syncDriftReason, 280),
    continuityDecision:
      task.continuityDecision === "direct_answer" ||
      task.continuityDecision === "attach_existing_task" ||
      task.continuityDecision === "new_task_candidate"
        ? task.continuityDecision
        : undefined,
    createdByApproval: task.createdByApproval === true,
    continuityHistory: normalizeContinuityHistory(task.continuityHistory),
    legacyLocalTerminal:
      paperclipIssueId?.trim()
        ? false
        : task.legacyLocalTerminal === true || isLegacyLocalTerminalTask({ status, source, paperclipIssueId }),
    nextStep: normalizePreview(task.nextStep, 220),
  };
}

function normalizeLedger(ledger: ChiefTaskLedger | null): ChiefTaskLedger {
  if (!ledger || typeof ledger !== "object") {
    return createEmptyLedger();
  }
  const tasksInput = ledger.tasks && typeof ledger.tasks === "object" ? ledger.tasks : {};
  const tasks = Object.fromEntries(
    Object.entries(tasksInput).map(([taskId, task]) => [taskId, normalizeTaskRecord(taskId, task)]),
  );
  return {
    version: CHIEF_TASK_LEDGER_VERSION,
    activeBySessionKey:
      ledger.activeBySessionKey && typeof ledger.activeBySessionKey === "object"
        ? ledger.activeBySessionKey
        : {},
    tasks,
  };
}

function normalizeArchiveEntry(taskId: string, entry: ChiefTaskLedgerArchiveEntry | null | undefined): ChiefTaskLedgerArchiveEntry {
  const task = entry?.task && typeof entry.task === "object" ? entry.task : ({} as ChiefTaskRecord);
  return {
    task: normalizeTaskRecord(taskId, { ...task, taskId }),
    archivedAt:
      typeof entry?.archivedAt === "number" && Number.isFinite(entry.archivedAt)
        ? entry.archivedAt
        : Date.now(),
    archiveReason: "legacy_local_terminal_retention",
  };
}

function normalizeArchive(archive: ChiefTaskLedgerArchive | null): ChiefTaskLedgerArchive {
  if (!archive || typeof archive !== "object") {
    return createEmptyArchive();
  }
  const archivedTasksInput =
    archive.archivedTasks && typeof archive.archivedTasks === "object" ? archive.archivedTasks : {};
  const archivedTasks = Object.fromEntries(
    Object.entries(archivedTasksInput).map(([taskId, entry]) => [
      taskId,
      normalizeArchiveEntry(taskId, entry as ChiefTaskLedgerArchiveEntry),
    ]),
  );
  return {
    version: CHIEF_TASK_LEDGER_ARCHIVE_VERSION,
    archiveLastRunAt:
      typeof archive.archiveLastRunAt === "number" && Number.isFinite(archive.archiveLastRunAt)
        ? archive.archiveLastRunAt
        : undefined,
    archiveLastOutcome:
      typeof archive.archiveLastOutcome === "string" && archive.archiveLastOutcome.trim()
        ? archive.archiveLastOutcome.trim()
        : undefined,
    archiveRetentionDays:
      typeof archive.archiveRetentionDays === "number" && Number.isFinite(archive.archiveRetentionDays)
        ? archive.archiveRetentionDays
        : undefined,
    archivedTasks,
  };
}

export function resolveChiefTaskLedgerPath(cfg: OpenClawConfig, agentId = "chief"): string {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return path.join(path.dirname(storePath), CHIEF_TASK_LEDGER_FILENAME);
}

export function resolveChiefRuntimeStatePath(cfg: OpenClawConfig, agentId = "chief"): string {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return path.join(path.dirname(storePath), CHIEF_RUNTIME_STATE_FILENAME);
}

export function resolveChiefTaskLedgerArchivePath(cfg: OpenClawConfig, agentId = "chief"): string {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return path.join(path.dirname(storePath), CHIEF_TASK_LEDGER_ARCHIVE_FILENAME);
}

async function loadLedger(filePath: string): Promise<ChiefTaskLedger> {
  return normalizeLedger(await readJsonFile<ChiefTaskLedger>(filePath));
}

async function loadArchive(filePath: string): Promise<ChiefTaskLedgerArchive> {
  return normalizeArchive(await readJsonFile<ChiefTaskLedgerArchive>(filePath));
}

function summarizeChiefRuntimeState(ledger: ChiefTaskLedger, nowMs: number): ChiefRuntimeState {
  const activeTasks = Object.values(ledger.tasks)
    .filter((task) => isResumeCandidate(task.status) && shouldTrackChiefRuntimeTask(task))
    .sort((a, b) => a.lastProgressAt - b.lastProgressAt)
    .map((task) => ({
      taskId: task.taskId,
      sessionKey: task.sessionKey,
      sessionId: task.sessionId,
      status: task.status,
      phase: task.phase,
      container: task.container,
      source: task.source,
      title: task.title,
      promptPreview: task.promptPreview,
      activeAgents: task.activeAgents,
      currentOwner: task.currentOwner,
      receiptId: task.receiptId,
      paperclipIssueId: task.paperclipIssueId,
      programId: task.programId,
      parentTaskId: task.parentTaskId,
      role: task.role,
      lastProgressAt: task.lastProgressAt,
      staleForMs: Math.max(0, nowMs - task.lastProgressAt),
      recoveryCount: task.recoveryCount,
      fallbackStage: task.fallbackStage,
      lastRecoveryAction: task.lastRecoveryAction,
      lastFallbackAction: task.lastFallbackAction,
      lastCompactionCause: task.lastCompactionCause,
      lastError: task.lastError,
      successCriteria: task.successCriteria,
      verificationEvidence: task.verificationEvidence,
      riskLevel: task.riskLevel,
      confidence: task.confidence,
      latestMilestone: task.latestMilestone,
      lastUserProgressReportAt: task.lastUserProgressReportAt,
      releaseGateStatus: task.releaseGateStatus,
      nextStep: task.nextStep,
    }));
  const stalledTasks = activeTasks.filter((task) => task.staleForMs >= CHIEF_TASK_STALE_AFTER_MS);
  const latestRecovery = activeTasks
    .filter((task) => typeof task.lastRecoveryAction === "string")
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt)[0];
  return {
    version: CHIEF_TASK_LEDGER_VERSION,
    generatedAt: nowMs,
    activeTaskCount: activeTasks.length,
    stalledTaskCount: stalledTasks.length,
    activeTask: activeTasks[0],
    activeTasks,
    lastRecovery: latestRecovery
      ? {
          taskId: latestRecovery.taskId,
          at: latestRecovery.lastProgressAt,
          action: latestRecovery.lastRecoveryAction || "unknown",
          fallbackStage: latestRecovery.fallbackStage,
          recoveryCount: latestRecovery.recoveryCount,
        }
      : undefined,
  };
}

async function writeLedger(filePath: string, ledger: ChiefTaskLedger): Promise<void> {
  const normalized = normalizeLedger(ledger);
  await writeJsonAtomic(filePath, normalized, { trailingNewline: true });
  const runtimeStatePath = path.join(path.dirname(filePath), CHIEF_RUNTIME_STATE_FILENAME);
  await writeJsonAtomic(runtimeStatePath, summarizeChiefRuntimeState(normalized, Date.now()), {
    trailingNewline: true,
  });
}

async function writeArchive(filePath: string, archive: ChiefTaskLedgerArchive): Promise<void> {
  const normalized = normalizeArchive(archive);
  await writeJsonAtomic(filePath, normalized, { trailingNewline: true });
}

function getChiefTaskTerminalTimestamp(task: ChiefTaskRecord): number | undefined {
  const candidates = [task.completedAt, task.lastProgressAt, task.updatedAt, task.createdAt].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function isChiefTaskTerminal(task: ChiefTaskRecord): boolean {
  return task.status === "done" || task.status === "blocked";
}

function isArchiveEligibleLegacyLocalTerminalTask(task: ChiefTaskRecord, nowMs: number, olderThanMs: number): boolean {
  if (task.legacyLocalTerminal !== true || !isChiefTaskTerminal(task)) {
    return false;
  }
  const terminalAt = getChiefTaskTerminalTimestamp(task);
  if (terminalAt == null) {
    return false;
  }
  return nowMs - terminalAt >= olderThanMs;
}

function derivePaperclipIssueId(sessionKey: string): string | undefined {
  const match = sessionKey.match(/paperclip:issue:([^:]+)/i);
  return match?.[1]?.trim() || undefined;
}

function deriveTaskSource(params: {
  sessionKey: string;
  sourceChannel?: string;
  explicitSource?: ChiefTaskSource;
  prompt?: string;
}): ChiefTaskSource {
  if (params.explicitSource) {
    return params.explicitSource;
  }
  if (params.sessionKey.trim().toLowerCase() === "agent:chief:paperclip") {
    return "internal";
  }
  if (derivePaperclipIssueId(params.sessionKey)) {
    return "paperclip";
  }
  const channel = params.sourceChannel?.trim().toLowerCase();
  if (channel === "telegram") {
    return "telegram";
  }
  if (channel === "internal") {
    return "internal";
  }
  if (channel) {
    return "direct";
  }
  return "unknown";
}

function isResumeCandidate(status: ChiefTaskStatus): boolean {
  return status === "in_progress" || status === "stalled";
}

function requiresConfirmedOutboundDelivery(task: Pick<ChiefTaskRecord, "source" | "receiptId">): boolean {
  return task.source === "telegram" && typeof task.receiptId === "string" && task.receiptId.trim().length > 0;
}

function shouldCascadeChiefTaskResult(anchor: ChiefTaskRecord, candidate: ChiefTaskRecord): boolean {
  if (anchor.taskId === candidate.taskId || !isResumeCandidate(candidate.status)) {
    return false;
  }
  if (
    anchor.receiptId?.trim() &&
    candidate.receiptId?.trim() &&
    anchor.receiptId.trim() === candidate.receiptId.trim()
  ) {
    return true;
  }
  if (
    anchor.paperclipIssueId?.trim() &&
    candidate.paperclipIssueId?.trim() &&
    anchor.paperclipIssueId.trim() === candidate.paperclipIssueId.trim()
  ) {
    return true;
  }
  if (
    anchor.programId?.trim() &&
    candidate.programId?.trim() &&
    anchor.programId.trim() === candidate.programId.trim()
  ) {
    return true;
  }
  return false;
}

function isChiefContinuationPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(CHIEF_CONTINUATION_PROMPT_PREFIX);
}

function inferChiefTaskStatusFromPayloads(payloads: ReplyLike[]): ChiefTaskStatus {
  const preview = normalizePreview(
    payloads
      .map((payload) => payload.text?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n"),
  );
  if (!preview) {
    return "in_progress";
  }
  if (/\[\[?complete\]?\]\s*:/i.test(preview)) {
    return "done";
  }
  if (/\[\[?waiting\]?\]\s*:/i.test(preview)) {
    return "awaiting_input";
  }
  if (/\[\[?blocked\]?\]\s*:/i.test(preview)) {
    return "blocked";
  }
  if (/\[\[?working\]?\]\s*:/i.test(preview)) {
    return "in_progress";
  }
  if (/\[\[?stop\]?\]\s*:?\s*completed\b/i.test(preview)) {
    return "done";
  }
  if (/\[\[?stop\]?\]\s*:/i.test(preview)) {
    return "blocked";
  }
  if (
    /\b(awaiting input|need more info|need more information|need clarification|please provide|can you clarify|could you clarify|cần thêm thông tin|cần làm rõ|hãy cung cấp|xin thêm)\b/i.test(
      preview,
    )
  ) {
    return "awaiting_input";
  }
  if (
    /\b(blocked|awaiting approval|cannot proceed|can't proceed|phụ thuộc|đang bị chặn|chờ phê duyệt|không thể tiếp tục)\b/i.test(
      preview,
    )
  ) {
    return "blocked";
  }
  if (
    /\b(in progress|still working|continuing|will continue|tiếp tục xử lý|đang xử lý|đang tiếp tục)\b/i.test(
      preview,
    )
  ) {
    return "in_progress";
  }
  return "done";
}

function parseTranscriptTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function extractTranscriptText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      return typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "";
    })
    .filter(Boolean)
    .join("\n");
  return normalizePreview(text, 2000);
}

async function reconcileChiefTaskFromTranscript(params: {
  cfg: OpenClawConfig;
  agentId: string;
  task: ChiefTaskRecord;
}): Promise<ChiefTaskRecord> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  let store: Record<string, unknown>;
  try {
    store = loadSessionStore(storePath, { skipCache: true });
  } catch {
    return params.task;
  }
  const resolved = resolveSessionStoreEntry({
    store: store as Parameters<typeof resolveSessionStoreEntry>[0]["store"],
    sessionKey: params.task.sessionKey,
  });
  const sessionEntry = resolved.existing;
  if (!sessionEntry?.sessionId) {
    return params.task;
  }
  const sessionFile = resolveSessionFilePath(sessionEntry.sessionId, sessionEntry, {
    agentId: params.agentId,
    sessionsDir: path.dirname(storePath),
  });
  if (!fs.existsSync(sessionFile)) {
    return params.task;
  }

  let raw = "";
  try {
    raw = await fs.promises.readFile(sessionFile, "utf-8");
  } catch {
    return params.task;
  }

  let latestUserTs = 0;
  let latestAssistantTs = 0;
  let latestAssistantText: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: {
      type?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; timestamp?: unknown; content?: unknown };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "message" || !parsed.message || typeof parsed.message !== "object") {
      continue;
    }
    const timestamp =
      parseTranscriptTimestamp(parsed.timestamp) ??
      parseTranscriptTimestamp(parsed.message.timestamp) ??
      0;
    if (timestamp < params.task.createdAt) {
      continue;
    }
    if (parsed.message.role === "user") {
      latestUserTs = Math.max(latestUserTs, timestamp);
      continue;
    }
    if (parsed.message.role !== "assistant") {
      continue;
    }
    const text = extractTranscriptText(parsed.message);
    if (!text) {
      continue;
    }
    if (timestamp >= latestAssistantTs) {
      latestAssistantTs = timestamp;
      latestAssistantText = text;
    }
  }

  if (!latestAssistantText || latestAssistantTs < latestUserTs) {
    return params.task;
  }

  const nextStatus = inferChiefTaskStatusFromPayloads([{ text: latestAssistantText }]);
  const nextPreview = normalizePreview(latestAssistantText);
  if (
    nextStatus === params.task.status &&
    latestAssistantTs <= params.task.lastProgressAt &&
    nextPreview === params.task.lastResponsePreview
  ) {
    return params.task;
  }

  return {
    ...params.task,
    status: nextStatus,
    updatedAt: Math.max(params.task.updatedAt, latestAssistantTs),
    lastProgressAt: Math.max(params.task.lastProgressAt, latestAssistantTs),
    lastResponsePreview: nextPreview ?? params.task.lastResponsePreview,
    ...(nextStatus === "done"
      ? { completedAt: Math.max(params.task.completedAt ?? 0, latestAssistantTs), lastError: undefined }
      : {}),
  };
}

function buildTaskId(params: {
  sessionKey: string;
  source: ChiefTaskSource;
  sourceMessageId?: string;
  paperclipIssueId?: string;
}): string {
  if (params.paperclipIssueId) {
    return `paperclip:${params.paperclipIssueId}`;
  }
  if (params.sourceMessageId) {
    return `${params.source}:${params.sessionKey}:${params.sourceMessageId}`;
  }
  return `chief:${randomUUID()}`;
}

function clearSessionActiveMapping(ledger: ChiefTaskLedger, sessionKey: string, taskId: string): void {
  if (ledger.activeBySessionKey[sessionKey] === taskId) {
    delete ledger.activeBySessionKey[sessionKey];
  }
}

function chooseChiefTaskContinuityDecision(params: {
  previous?: InboundReceiptContinuityDecision;
  next?: InboundReceiptContinuityDecision;
}): InboundReceiptContinuityDecision | undefined {
  const previousStrength =
    params.previous != null ? CONTINUITY_DECISION_STRENGTH[params.previous] : -1;
  const nextStrength = params.next != null ? CONTINUITY_DECISION_STRENGTH[params.next] : -1;
  if (nextStrength >= previousStrength) {
    return params.next ?? params.previous;
  }
  return params.previous;
}

function resolveChiefTaskReuseCandidate(params: {
  matchedTask?: ChiefTaskRecord;
  existingTask?: ChiefTaskRecord;
  receiptId?: string;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  continuityDecision?: InboundReceiptContinuityDecision;
  openIntentKey?: string;
  isContinuationPrompt: boolean;
}): ChiefTaskRecord | undefined {
  if (params.continuityDecision === "attach_existing_task" && params.matchedTask) {
    return params.matchedTask;
  }
  const existingTask = params.existingTask;
  if (!existingTask || !isResumeCandidate(existingTask.status)) {
    return undefined;
  }
  const receiptId = params.receiptId?.trim();
  const sourceMessageId = params.sourceMessageId?.trim();
  const paperclipIssueId = params.paperclipIssueId?.trim();
  const openIntentKey = normalizePreview(params.openIntentKey, 160);
  const hasExplicitIdentity = Boolean(receiptId || sourceMessageId || paperclipIssueId);

  if (receiptId && existingTask.receiptId === receiptId) {
    return existingTask;
  }
  if (sourceMessageId && existingTask.sourceMessageId === sourceMessageId) {
    return existingTask;
  }
  if (paperclipIssueId && existingTask.paperclipIssueId === paperclipIssueId) {
    return existingTask;
  }
  if (
    params.continuityDecision === "attach_existing_task" &&
    openIntentKey &&
    existingTask.openIntentKey === openIntentKey
  ) {
    return existingTask;
  }
  if (!hasExplicitIdentity && params.isContinuationPrompt) {
    return existingTask;
  }
  return undefined;
}

export async function recordChiefTaskStart(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  prompt: string;
  sourceChannel?: string;
  receiptId?: string;
  sourceMessageId?: string;
  source?: ChiefTaskSource;
  matchedTaskId?: string;
  paperclipIssueId?: string;
  programId?: string;
  parentTaskId?: string;
  role?: string;
  threadKey?: string;
  openIntentKey?: string;
  intentSummary?: string;
  currentGoal?: string;
  successCriteria?: string;
  verificationEvidence?: string[];
  riskLevel?: ChiefTaskRiskLevel;
  confidence?: number;
  latestMilestone?: string;
  lastUserProgressReportAt?: number;
  releaseGateStatus?: ChiefTaskReleaseGateStatus;
  paperclipRunId?: string;
  continuityDecision?: InboundReceiptContinuityDecision;
  createdByApproval?: boolean;
  nowMs?: number;
}): Promise<ChiefTaskRecord | null> {
  if (!isChiefAgentId(params.agentId) || !params.sessionKey.trim()) {
    return null;
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const sessionKey = params.sessionKey.trim();
    const source = deriveTaskSource({
      sessionKey,
      sourceChannel: params.sourceChannel,
      explicitSource: params.source,
      prompt: params.prompt,
    });
    const existingTaskId = ledger.activeBySessionKey[sessionKey];
    const existingTask = existingTaskId ? ledger.tasks[existingTaskId] : undefined;
    const matchedTaskId = params.matchedTaskId?.trim();
    const matchedTask =
      matchedTaskId && isContinuableTaskStatus(ledger.tasks[matchedTaskId]?.status ?? "done")
        ? ledger.tasks[matchedTaskId]
        : undefined;
    const isContinuationPrompt = isChiefContinuationPrompt(params.prompt);
    const reuseTask = resolveChiefTaskReuseCandidate({
      matchedTask,
      existingTask,
      receiptId: params.receiptId,
      sourceMessageId: params.sourceMessageId,
      paperclipIssueId: params.paperclipIssueId,
      continuityDecision: params.continuityDecision,
      openIntentKey: params.openIntentKey,
      isContinuationPrompt,
    });
    const candidatePaperclipIssueId =
      params.paperclipIssueId?.trim() ||
      reuseTask?.paperclipIssueId ||
      existingTask?.paperclipIssueId ||
      derivePaperclipIssueId(sessionKey);
    const taskId =
      reuseTask
        ? reuseTask.taskId
        : buildTaskId({
            sessionKey,
            source,
            sourceMessageId: params.sourceMessageId,
            paperclipIssueId: candidatePaperclipIssueId,
          });
    const previous = ledger.tasks[taskId];
    const continuityDecision = chooseChiefTaskContinuityDecision({
      previous:
        previous?.continuityDecision ??
        reuseTask?.continuityDecision ??
        (params.continuityDecision === "attach_existing_task" && matchedTask
          ? "attach_existing_task"
          : undefined),
      next: params.continuityDecision,
    });
    const preservePreviousTaskContext = isContinuationPrompt && previous != null;
    const preserveTrackedTaskContext =
      reuseTask != null &&
      (reuseTask.createdByApproval === true || Boolean(reuseTask.paperclipIssueId?.trim()));
    const preservedTaskContext =
      preservePreviousTaskContext || preserveTrackedTaskContext
        ? (previous ?? reuseTask)
        : undefined;
    const continuityHistory =
      continuityDecision != null
        ? [
            ...(previous?.continuityHistory ?? []),
            {
              at: nowMs,
              decision: continuityDecision,
              receiptId:
                params.receiptId?.trim() ||
                preservedTaskContext?.receiptId ||
                previous?.receiptId,
              sourceMessageId:
                params.sourceMessageId?.trim() ||
                preservedTaskContext?.sourceMessageId ||
                previous?.sourceMessageId,
            },
          ].slice(-12)
        : previous?.continuityHistory;
    const resolvedThreadKey =
      normalizeThreadKey(params.threadKey, sessionKey) ??
      preservedTaskContext?.threadKey ??
      previous?.threadKey ??
      reuseTask?.threadKey ??
      normalizeThreadKey(sessionKey, sessionKey);
    const resolvedOpenIntentKey =
      normalizePreview(params.openIntentKey, 160) ??
      preservedTaskContext?.openIntentKey ??
      previous?.openIntentKey;
    const resolvedCurrentGoal =
      normalizePreview(params.currentGoal, 220) ??
      preservedTaskContext?.currentGoal ??
      previous?.currentGoal;
    const resolvedProgramId =
      normalizeProgramId(params.programId) ??
      preservedTaskContext?.programId ??
      previous?.programId ??
      (resolvedThreadKey && resolvedOpenIntentKey
        ? `${resolvedThreadKey}#${resolvedOpenIntentKey}`
        : resolvedThreadKey ?? sessionKey);
    const resolvedRole =
      normalizePreview(params.role, 80) ??
      preservedTaskContext?.role ??
      previous?.role ??
      "executive_owner";
    const resolvedSuccessCriteria =
      normalizePreview(params.successCriteria, 280) ??
      normalizePreview(resolvedCurrentGoal, 280) ??
      preservedTaskContext?.successCriteria ??
      previous?.successCriteria;
    const resolvedRiskLevel =
      normalizeRiskLevel(params.riskLevel) ??
      preservedTaskContext?.riskLevel ??
      previous?.riskLevel ??
      (continuityDecision === "new_task_candidate" ? "medium" : "low");
    const resolvedConfidence =
      normalizeConfidence(params.confidence) ??
      preservedTaskContext?.confidence ??
      previous?.confidence;
    const resolvedReleaseGateStatus =
      normalizeReleaseGateStatus(params.releaseGateStatus) ??
      preservedTaskContext?.releaseGateStatus ??
      previous?.releaseGateStatus ??
      (resolveReleaseGateRequired(params.cfg) ? "required" : "not_required");
    const resolvedVerificationEvidence =
      normalizeVerificationEvidence(params.verificationEvidence) ??
      preservedTaskContext?.verificationEvidence ??
      previous?.verificationEvidence;
    const resolvedLatestMilestone =
      normalizePreview(params.latestMilestone, 220) ??
      preservedTaskContext?.latestMilestone ??
      previous?.latestMilestone ??
      "Intake completed; execution started.";
    const resolvedPaperclipRunId =
      normalizePreview(params.paperclipRunId, 160) ??
      preservedTaskContext?.paperclipRunId ??
      previous?.paperclipRunId;
    const resolvedHeadline = resolveChiefTaskHeadlineFromFields({
      currentGoal: resolvedCurrentGoal,
      intentSummary:
        normalizePreview(params.intentSummary, 220) ??
        preservedTaskContext?.intentSummary ??
        previous?.intentSummary,
      successCriteria: resolvedSuccessCriteria,
      title: preservedTaskContext?.title ?? normalizeTitle(params.prompt),
      promptPreview:
        (preservedTaskContext?.promptPreview ?? normalizePreview(params.prompt)) ?? "Chief task",
    });
    const resolvedLastUserProgressReportAt =
      typeof params.lastUserProgressReportAt === "number" &&
      Number.isFinite(params.lastUserProgressReportAt)
        ? params.lastUserProgressReportAt
        : preservedTaskContext?.lastUserProgressReportAt ??
          previous?.lastUserProgressReportAt;
    const paperclipIssueId = await ensureChiefTaskAuthority({
      source: preservedTaskContext?.source ?? source,
      paperclipIssueId:
        candidatePaperclipIssueId ||
        previous?.paperclipIssueId ||
        reuseTask?.paperclipIssueId ||
        derivePaperclipIssueId(sessionKey),
      receiptId:
        (preservedTaskContext?.receiptId ?? params.receiptId?.trim()) ||
        previous?.receiptId,
      prompt: preservedTaskContext?.promptPreview ?? params.prompt,
      title: preservedTaskContext?.title,
      programId: resolvedProgramId,
      parentTaskId:
        params.parentTaskId?.trim() ||
        preservedTaskContext?.parentTaskId ||
        previous?.parentTaskId,
      role: resolvedRole,
      threadKey: resolvedThreadKey,
      openIntentKey: resolvedOpenIntentKey,
      intentSummary:
        normalizePreview(params.intentSummary, 220) ??
        preservedTaskContext?.intentSummary ??
        previous?.intentSummary,
      successCriteria: resolvedSuccessCriteria,
      riskLevel: resolvedRiskLevel,
      confidence: resolvedConfidence,
      releaseGateStatus: resolvedReleaseGateStatus,
      phase: "executing",
      currentOwner: "chief",
      activeAgents: previous?.activeAgents?.length ? previous.activeAgents : ["chief"],
      latestMilestone: resolvedLatestMilestone,
      nextStep: previous?.nextStep,
      verificationEvidence: resolvedVerificationEvidence,
      sourceMessageId:
        (preservedTaskContext?.sourceMessageId ?? params.sourceMessageId?.trim()) ||
        previous?.sourceMessageId,
      createdByApproval:
        params.createdByApproval === true ||
        preservedTaskContext?.createdByApproval === true ||
        previous?.createdByApproval === true,
      paperclipRunId: resolvedPaperclipRunId,
    });
    const container = deriveTaskContainer(source, paperclipIssueId);
    const next: ChiefTaskRecord = {
      taskId,
      agentId: params.agentId.trim().toLowerCase(),
      sessionKey,
      sessionId: params.sessionId?.trim() || previous?.sessionId,
      status: "in_progress",
      phase: "executing",
      container: preservedTaskContext?.container ?? container,
      source: preservedTaskContext?.source ?? source,
      title: preservedTaskContext?.title ?? normalizeTitle(params.prompt),
      promptPreview:
        (preservedTaskContext?.promptPreview ?? normalizePreview(params.prompt)) ?? "Chief task",
      createdAt: previous?.createdAt ?? nowMs,
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      activeAgents: previous?.activeAgents?.length ? previous.activeAgents : ["chief"],
      currentOwner: "chief",
      receiptId:
        (preservedTaskContext?.receiptId ?? params.receiptId?.trim()) ||
        previous?.receiptId,
      sourceMessageId:
        (preservedTaskContext?.sourceMessageId ?? params.sourceMessageId?.trim()) ||
        previous?.sourceMessageId,
      paperclipIssueId: paperclipIssueId || previous?.paperclipIssueId,
      programId: resolvedProgramId,
      parentTaskId:
        params.parentTaskId?.trim() ||
        preservedTaskContext?.parentTaskId ||
        previous?.parentTaskId,
      role: resolvedRole,
      threadKey: resolvedThreadKey,
      openIntentKey: resolvedOpenIntentKey,
      intentSummary:
        normalizePreview(params.intentSummary, 220) ??
        preservedTaskContext?.intentSummary ??
        previous?.intentSummary,
      currentGoal: resolvedCurrentGoal,
      successCriteria: resolvedSuccessCriteria,
      taskHeadline: resolvedHeadline.text,
      taskHeadlineKind: resolvedHeadline.kind,
      verificationEvidence: resolvedVerificationEvidence,
      riskLevel: resolvedRiskLevel,
      confidence: resolvedConfidence,
      latestMilestone: resolvedLatestMilestone,
      lastUserProgressReportAt: resolvedLastUserProgressReportAt,
      releaseGateStatus: resolvedReleaseGateStatus,
      paperclipRunId: resolvedPaperclipRunId,
      syncDriftReason: previous?.syncDriftReason,
      continuityDecision,
      createdByApproval:
        params.createdByApproval === true ||
        preservedTaskContext?.createdByApproval === true ||
        previous?.createdByApproval === true,
      continuityHistory,
      legacyLocalTerminal: paperclipIssueId ? false : previous?.legacyLocalTerminal === true,
      lastResponsePreview: previous?.lastResponsePreview,
      lastError: previous?.lastError,
      runAttempts: (previous?.runAttempts ?? 0) + 1,
      resumeAttempts: previous?.resumeAttempts ?? 0,
      recoveryCount: previous?.recoveryCount ?? 0,
      fallbackStage: previous?.fallbackStage ?? "none",
      lastRecoveryAction: previous?.lastRecoveryAction,
      lastFallbackAction: previous?.lastFallbackAction,
      lastCompactionCause: previous?.lastCompactionCause,
      nextStep: previous?.nextStep,
      lastResumeRequestedAt: previous?.lastResumeRequestedAt,
    };
    ledger.tasks[taskId] = next;
    ledger.activeBySessionKey[sessionKey] = taskId;
    await writeLedger(filePath, ledger);
    await syncInboundReceiptFromChiefTask({
      cfg: params.cfg,
      task: {
        taskId: next.taskId,
        agentId: next.agentId,
        sessionKey: next.sessionKey,
        source: next.source,
        promptPreview: next.promptPreview,
        sourceMessageId: next.sourceMessageId,
        paperclipIssueId: next.paperclipIssueId,
        receiptId: next.receiptId,
        status: next.status,
        phase: next.phase,
        lastProgressAt: next.lastProgressAt,
        lastError: next.lastError,
        runAttempts: next.runAttempts,
        recoveryCount: next.recoveryCount,
        bodyText: isContinuationPrompt ? undefined : params.prompt,
        threadKey: next.threadKey,
        continuityDecision: next.continuityDecision,
        openIntentKey: next.openIntentKey,
        createdByApproval: next.createdByApproval,
      },
      stage: "task_created",
    });
    let syncedNext = next;
    if (next.paperclipIssueId) {
      const syncOutcome = await syncPaperclipIssueForTask(next);
      syncedNext = applyPaperclipSyncOutcome(next, syncOutcome);
      if (syncedNext !== next) {
        ledger.tasks[taskId] = syncedNext;
        await writeLedger(filePath, ledger);
      }
    }
    return syncedNext;
  });
}

export async function recordChiefTaskResult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId?: string;
  receiptId?: string;
  sessionKey: string;
  payloads?: ReplyLike[];
  deliveryConfirmed?: boolean;
  verificationEvidence?: string[];
  releaseGateStatus?: ChiefTaskReleaseGateStatus;
  latestMilestone?: string;
  lastUserProgressReportAt?: number;
  paperclipRunId?: string;
  nowMs?: number;
}): Promise<ChiefTaskRecord | null> {
  if (!isChiefAgentId(params.agentId) || !params.sessionKey.trim()) {
    return null;
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const sessionKey = params.sessionKey.trim();
    const receiptId = params.receiptId?.trim();
    const taskId =
      params.taskId?.trim() ||
      (receiptId
        ? Object.values(ledger.tasks).find((candidate) => candidate.receiptId?.trim() === receiptId)?.taskId
        : undefined) ||
      ledger.activeBySessionKey[sessionKey];
    if (!taskId) {
      return null;
    }
    const task = ledger.tasks[taskId];
    if (!task) {
      return null;
    }
    const payloads = params.payloads ?? [];
    const preview = normalizePreview(
      payloads
        .map((payload) => payload.text?.trim())
        .filter((value): value is string => Boolean(value))
        .join("\n"),
    );
    const silentNoReply = isSilentChiefNoReplyPayloads(payloads);
    const inferredStatus = inferChiefTaskStatusFromPayloads(payloads);
    const deliveryConfirmed = params.deliveryConfirmed !== false;
    const previewOrDeliveryEvidence =
      Boolean(preview) ||
      payloads.some(
        (payload) =>
          Array.isArray(payload.mediaUrls) && payload.mediaUrls.some((value) => Boolean(value?.trim())),
      ) ||
      (deliveryConfirmed && payloads.length === 0);
    const invalidTrackedNoReply =
      requiresConfirmedOutboundDelivery(task) &&
      !deliveryConfirmed &&
      (!previewOrDeliveryEvidence || silentNoReply);
    const resolvedPaperclipRunId =
      normalizePreview(params.paperclipRunId, 160) ?? task.paperclipRunId;
    const headline = resolveChiefTaskHeadline(task);
    const verificationEvidence = normalizeVerificationEvidence([
      ...(task.verificationEvidence ?? []),
      ...(params.verificationEvidence ?? []),
      deliveryConfirmed ? "delivery_confirmed" : "delivery_pending",
      previewOrDeliveryEvidence ? "final_preview_present" : "final_preview_missing",
      ...(silentNoReply ? ["silent_no_reply_detected"] : []),
      ...(invalidTrackedNoReply ? ["invalid_no_reply_on_resume"] : []),
    ]);
    const status =
      invalidTrackedNoReply
        ? "blocked"
        : ((!deliveryConfirmed || !previewOrDeliveryEvidence) &&
      requiresConfirmedOutboundDelivery(task) &&
      (inferredStatus === "done" || inferredStatus === "awaiting_input" || inferredStatus === "blocked"))
          ? "in_progress"
          : inferredStatus;
    const next: ChiefTaskRecord = {
      ...task,
      status,
      phase: derivePhaseFromStatus(status),
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      activeAgents: status === "done" ? ["chief"] : task.activeAgents,
      currentOwner: "chief",
      lastResponsePreview: preview ?? task.lastResponsePreview,
      taskHeadline: task.taskHeadline ?? headline.text,
      taskHeadlineKind: task.taskHeadlineKind ?? headline.kind,
      verificationEvidence,
      latestMilestone:
        normalizePreview(params.latestMilestone, 220) ??
        (invalidTrackedNoReply
          ? "Chief ended without a deliverable user-facing terminal reply; recovery summary is required."
          : status === "done"
            ? "Release gate passed; final delivery completed."
            : status === "awaiting_input"
              ? "Chief is waiting for required user input."
              : status === "blocked"
                ? "Chief reached a blocker that needs intervention."
                : task.latestMilestone),
      releaseGateStatus:
        normalizeReleaseGateStatus(params.releaseGateStatus) ??
        (invalidTrackedNoReply
          ? "blocked"
          : status === "done"
            ? "passed"
            : status === "blocked"
              ? "blocked"
              : status === "awaiting_input"
                ? task.releaseGateStatus ?? "reviewing"
                : task.releaseGateStatus),
      lastUserProgressReportAt:
        typeof params.lastUserProgressReportAt === "number" &&
        Number.isFinite(params.lastUserProgressReportAt)
          ? params.lastUserProgressReportAt
          : task.lastUserProgressReportAt,
      paperclipRunId: resolvedPaperclipRunId,
      syncDriftReason: task.syncDriftReason,
      ...(status === "done" ? { completedAt: nowMs } : {}),
      ...(status === "done" ? { lastError: undefined } : {}),
      ...(invalidTrackedNoReply
        ? {
            lastError:
              "Chief run ended without a deliverable terminal reply for this tracked Telegram task.",
            lastFallbackAction: "invalid_no_reply_on_resume",
            nextStep:
              "Send a structured recovery update with `[BLOCKED]`, `[WAITING]`, `[STOP]`, or `[COMPLETE]` instead of NO_REPLY.",
          }
        : status !== inferredStatus
        ? {
            nextStep: !deliveryConfirmed
              ? "Await confirmed outbound delivery before terminalizing this Telegram task."
              : "Await a visible final preview before terminalizing this Telegram task.",
          }
        : {}),
    };
    ledger.tasks[taskId] = next;
    if (!isResumeCandidate(status)) {
      clearSessionActiveMapping(ledger, sessionKey, taskId);
    } else {
      ledger.activeBySessionKey[sessionKey] = taskId;
    }
    const relatedTasks = !isResumeCandidate(status)
      ? Object.values(ledger.tasks)
          .filter((candidate): candidate is ChiefTaskRecord => Boolean(candidate))
          .filter((candidate) => shouldCascadeChiefTaskResult(next, candidate))
      : [];
    for (const relatedTask of relatedTasks) {
      const cascaded: ChiefTaskRecord = {
        ...relatedTask,
        status: next.status,
        phase: next.phase,
        updatedAt: nowMs,
        lastProgressAt: nowMs,
        activeAgents: next.status === "done" ? ["chief"] : relatedTask.activeAgents,
        currentOwner: "chief",
        lastResponsePreview: next.lastResponsePreview ?? relatedTask.lastResponsePreview,
        verificationEvidence: normalizeVerificationEvidence([
          ...(relatedTask.verificationEvidence ?? []),
          ...(next.verificationEvidence ?? []),
          "related_task_terminalized",
        ]),
        latestMilestone: next.latestMilestone,
        releaseGateStatus: next.releaseGateStatus,
        lastUserProgressReportAt: next.lastUserProgressReportAt ?? relatedTask.lastUserProgressReportAt,
        nextStep: next.nextStep,
        ...(next.status === "done" ? { completedAt: nowMs, lastError: undefined } : {}),
      };
      ledger.tasks[relatedTask.taskId] = cascaded;
      clearSessionActiveMapping(ledger, relatedTask.sessionKey, relatedTask.taskId);
    }
    await writeLedger(filePath, ledger);
    await syncInboundReceiptFromChiefTask({
      cfg: params.cfg,
      task: {
        taskId: next.taskId,
        agentId: next.agentId,
        sessionKey: next.sessionKey,
        source: next.source,
        promptPreview: next.promptPreview,
        sourceMessageId: next.sourceMessageId,
        paperclipIssueId: next.paperclipIssueId,
        receiptId: next.receiptId,
        status: next.status,
        phase: next.phase,
        lastProgressAt: next.lastProgressAt,
        lastError: next.lastError,
        runAttempts: next.runAttempts,
        recoveryCount: next.recoveryCount,
        threadKey: next.threadKey,
        continuityDecision: next.continuityDecision,
        openIntentKey: next.openIntentKey,
        createdByApproval: next.createdByApproval,
      },
    });
    const nextSyncOutcome = await syncPaperclipIssueForTask(next);
    const syncedNext = applyPaperclipSyncOutcome(next, nextSyncOutcome);
    if (syncedNext !== next) {
      ledger.tasks[next.taskId] = syncedNext;
    }
    for (const relatedTask of relatedTasks) {
      const cascadedCurrent = ledger.tasks[relatedTask.taskId];
      if (!cascadedCurrent) {
        continue;
      }
      const cascadedSyncOutcome = await syncPaperclipIssueForTask(cascadedCurrent);
      const cascaded = applyPaperclipSyncOutcome(cascadedCurrent, cascadedSyncOutcome);
      if (cascaded !== cascadedCurrent) {
        ledger.tasks[relatedTask.taskId] = cascaded;
      }
      if (!cascaded) {
        continue;
      }
      await syncInboundReceiptFromChiefTask({
        cfg: params.cfg,
        task: {
          taskId: cascaded.taskId,
          agentId: cascaded.agentId,
          sessionKey: cascaded.sessionKey,
          source: cascaded.source,
          promptPreview: cascaded.promptPreview,
          sourceMessageId: cascaded.sourceMessageId,
          paperclipIssueId: cascaded.paperclipIssueId,
          receiptId: cascaded.receiptId,
          status: cascaded.status,
          phase: cascaded.phase,
          lastProgressAt: cascaded.lastProgressAt,
          lastError: cascaded.lastError,
          runAttempts: cascaded.runAttempts,
          recoveryCount: cascaded.recoveryCount,
          threadKey: cascaded.threadKey,
          continuityDecision: cascaded.continuityDecision,
          openIntentKey: cascaded.openIntentKey,
          createdByApproval: cascaded.createdByApproval,
        },
      });
    }
    await writeLedger(filePath, ledger);
    return ledger.tasks[taskId] ?? syncedNext;
  });
}

export async function recordChiefTaskProgress(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId?: string;
  sessionKey: string;
  sessionId?: string;
  phase?: ChiefTaskPhase;
  activeAgents?: string[];
  currentOwner?: string;
  latestMilestone?: string;
  verificationEvidence?: string[];
  riskLevel?: ChiefTaskRiskLevel;
  confidence?: number;
  lastUserProgressReportAt?: number;
  releaseGateStatus?: ChiefTaskReleaseGateStatus;
  fallbackStage?: string;
  lastRecoveryAction?: string;
  lastFallbackAction?: string;
  lastCompactionCause?: string;
  nextStep?: string;
  paperclipRunId?: string;
  nowMs?: number;
}): Promise<ChiefTaskRecord | null> {
  if (!isChiefAgentId(params.agentId) || !params.sessionKey.trim()) {
    return null;
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const sessionKey = params.sessionKey.trim();
    const taskId = params.taskId?.trim() || ledger.activeBySessionKey[sessionKey];
    if (!taskId) {
      return null;
    }
    const task = ledger.tasks[taskId];
    if (!task) {
      return null;
    }
    const headline = resolveChiefTaskHeadline(task);
    const next: ChiefTaskRecord = {
      ...task,
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      sessionId: params.sessionId?.trim() || task.sessionId,
      phase: params.phase ?? task.phase,
      activeAgents:
        params.activeAgents
          ?.map((value) => value.trim())
          .filter(Boolean)
          .slice() ?? task.activeAgents,
      currentOwner: params.currentOwner?.trim() || task.currentOwner,
      fallbackStage: params.fallbackStage?.trim() || task.fallbackStage,
      lastRecoveryAction: params.lastRecoveryAction?.trim() || task.lastRecoveryAction,
      lastFallbackAction: params.lastFallbackAction?.trim() || task.lastFallbackAction,
      lastCompactionCause: params.lastCompactionCause?.trim() || task.lastCompactionCause,
      latestMilestone: normalizePreview(params.latestMilestone, 220) ?? task.latestMilestone,
      taskHeadline: task.taskHeadline ?? headline.text,
      taskHeadlineKind: task.taskHeadlineKind ?? headline.kind,
      verificationEvidence: normalizeVerificationEvidence([
        ...(task.verificationEvidence ?? []),
        ...(params.verificationEvidence ?? []),
      ]) ?? task.verificationEvidence,
      riskLevel: normalizeRiskLevel(params.riskLevel) ?? task.riskLevel,
      confidence: normalizeConfidence(params.confidence) ?? task.confidence,
      lastUserProgressReportAt:
        typeof params.lastUserProgressReportAt === "number" &&
        Number.isFinite(params.lastUserProgressReportAt)
          ? params.lastUserProgressReportAt
          : task.lastUserProgressReportAt,
      releaseGateStatus:
        normalizeReleaseGateStatus(params.releaseGateStatus) ?? task.releaseGateStatus,
      nextStep: normalizePreview(params.nextStep, 220) ?? task.nextStep,
      paperclipRunId: normalizePreview(params.paperclipRunId, 160) ?? task.paperclipRunId,
    };
    ledger.tasks[taskId] = next;
    ledger.activeBySessionKey[sessionKey] = taskId;
    await writeLedger(filePath, ledger);
    await syncInboundReceiptFromChiefTask({
      cfg: params.cfg,
      task: {
        taskId: next.taskId,
        agentId: next.agentId,
        sessionKey: next.sessionKey,
        source: next.source,
        promptPreview: next.promptPreview,
        sourceMessageId: next.sourceMessageId,
        paperclipIssueId: next.paperclipIssueId,
        receiptId: next.receiptId,
        status: next.status,
        phase: next.phase,
        lastProgressAt: next.lastProgressAt,
        lastError: next.lastError,
        runAttempts: next.runAttempts,
        recoveryCount: next.recoveryCount,
        threadKey: next.threadKey,
        continuityDecision: next.continuityDecision,
        openIntentKey: next.openIntentKey,
        createdByApproval: next.createdByApproval,
      },
    });
    if (
      params.releaseGateStatus != null ||
      params.latestMilestone != null ||
      params.paperclipRunId != null ||
      (params.phase != null &&
        (params.phase === "reviewing" || params.phase === "awaiting_input" || params.phase === "blocked"))
    ) {
      const syncOutcome = await syncPaperclipIssueForTask(next);
      const syncedNext = applyPaperclipSyncOutcome(next, syncOutcome);
      if (syncedNext !== next) {
        ledger.tasks[taskId] = syncedNext;
        await writeLedger(filePath, ledger);
        return syncedNext;
      }
    }
    return next;
  });
}

export async function recordChiefTaskFailure(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId?: string;
  sessionKey: string;
  error: unknown;
  paperclipRunId?: string;
  nowMs?: number;
}): Promise<ChiefTaskRecord | null> {
  if (!isChiefAgentId(params.agentId) || !params.sessionKey.trim()) {
    return null;
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const sessionKey = params.sessionKey.trim();
    const taskId = params.taskId?.trim() || ledger.activeBySessionKey[sessionKey];
    if (!taskId) {
      return null;
    }
    const task = ledger.tasks[taskId];
    if (!task) {
      return null;
    }
    const next: ChiefTaskRecord = {
      ...task,
      status: "stalled",
      phase: "blocked",
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      lastError: normalizePreview(String(params.error), 400),
      lastFallbackAction: "runtime_error",
      latestMilestone: "Chief execution failed and needs recovery.",
      riskLevel: "high",
      releaseGateStatus: "blocked",
      paperclipRunId: normalizePreview(params.paperclipRunId, 160) ?? task.paperclipRunId,
    };
    ledger.tasks[taskId] = next;
    ledger.activeBySessionKey[sessionKey] = taskId;
    await writeLedger(filePath, ledger);
    await syncInboundReceiptFromChiefTask({
      cfg: params.cfg,
      task: {
        taskId: next.taskId,
        agentId: next.agentId,
        sessionKey: next.sessionKey,
        source: next.source,
        promptPreview: next.promptPreview,
        sourceMessageId: next.sourceMessageId,
        paperclipIssueId: next.paperclipIssueId,
        receiptId: next.receiptId,
        status: next.status,
        phase: next.phase,
        lastProgressAt: next.lastProgressAt,
        lastError: next.lastError,
        runAttempts: next.runAttempts,
        recoveryCount: next.recoveryCount,
        threadKey: next.threadKey,
        continuityDecision: next.continuityDecision,
        openIntentKey: next.openIntentKey,
        createdByApproval: next.createdByApproval,
      },
      stage: "executing",
    });
    const syncOutcome = await syncPaperclipIssueForTask(next);
    const syncedNext = applyPaperclipSyncOutcome(next, syncOutcome);
    if (syncedNext !== next) {
      ledger.tasks[taskId] = syncedNext;
      await writeLedger(filePath, ledger);
    }
    return syncedNext;
  });
}

export async function recordChiefTaskRecovery(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId: string;
  fallbackStage: string;
  action: string;
  activeAgents?: string[];
  paperclipRunId?: string;
  nowMs?: number;
}): Promise<ChiefTaskRecord | null> {
  if (!isChiefAgentId(params.agentId) || !params.taskId.trim()) {
    return null;
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const task = ledger.tasks[params.taskId];
    if (!task) {
      return null;
    }
    const next: ChiefTaskRecord = {
      ...task,
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      phase: "executing",
      recoveryCount: task.recoveryCount + 1,
      fallbackStage: params.fallbackStage.trim() || task.fallbackStage,
      lastRecoveryAction: params.action.trim() || task.lastRecoveryAction,
      lastFallbackAction: params.action.trim() || task.lastFallbackAction,
      activeAgents:
        params.activeAgents
          ?.map((value) => value.trim())
          .filter(Boolean)
          .slice() ?? task.activeAgents,
      paperclipRunId: normalizePreview(params.paperclipRunId, 160) ?? task.paperclipRunId,
    };
    ledger.tasks[params.taskId] = next;
    ledger.activeBySessionKey[next.sessionKey] = next.taskId;
    await writeLedger(filePath, ledger);
    await syncInboundReceiptFromChiefTask({
      cfg: params.cfg,
      task: {
        taskId: next.taskId,
        agentId: next.agentId,
        sessionKey: next.sessionKey,
        source: next.source,
        promptPreview: next.promptPreview,
        sourceMessageId: next.sourceMessageId,
        paperclipIssueId: next.paperclipIssueId,
        receiptId: next.receiptId,
        status: next.status,
        phase: next.phase,
        lastProgressAt: next.lastProgressAt,
        lastError: next.lastError,
        runAttempts: next.runAttempts,
        recoveryCount: next.recoveryCount,
        threadKey: next.threadKey,
        continuityDecision: next.continuityDecision,
        openIntentKey: next.openIntentKey,
        createdByApproval: next.createdByApproval,
      },
      stage: "executing",
    });
    const syncOutcome = await syncPaperclipIssueForTask(next);
    const syncedNext = applyPaperclipSyncOutcome(next, syncOutcome);
    if (syncedNext !== next) {
      ledger.tasks[params.taskId] = syncedNext;
      await writeLedger(filePath, ledger);
    }
    return syncedNext;
  });
}

export async function markChiefTaskResumeRequested(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId: string;
  nowMs?: number;
}): Promise<ChiefTaskRecord | null> {
  if (!isChiefAgentId(params.agentId) || !params.taskId.trim()) {
    return null;
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const task = ledger.tasks[params.taskId];
    if (!task) {
      return null;
    }
    const next: ChiefTaskRecord = {
      ...task,
      updatedAt: nowMs,
      lastResumeRequestedAt: nowMs,
      resumeAttempts: task.resumeAttempts + 1,
      lastRecoveryAction: "resume_requested",
      lastFallbackAction: "resume_requested",
    };
    ledger.tasks[params.taskId] = next;
    await writeLedger(filePath, ledger);
    return next;
  });
}

export async function reconcileChiefTaskAuthority(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<ChiefTaskLedger> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  if (!isChiefAgentId(agentId)) {
    return createEmptyLedger();
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, agentId);
  return await withChiefTaskLedgerLock(async () => {
    const rawLedger = await readJsonFile<ChiefTaskLedger>(filePath);
    const ledger = normalizeLedger(rawLedger);
    let changed =
      JSON.stringify(rawLedger ?? createEmptyLedger()) !== JSON.stringify(ledger);
    const syncedTasks: ChiefTaskRecord[] = [];

    for (const [taskId, task] of Object.entries(ledger.tasks)) {
      let next = task;

      if (requiresPaperclipTaskAuthority(task.source) && !task.paperclipIssueId && isResumeCandidate(task.status)) {
        const paperclipIssueId = await ensureChiefTaskAuthority({
          source: task.source,
          receiptId: task.receiptId,
          prompt: task.promptPreview || task.title,
          title: task.title,
          threadKey: task.threadKey,
          openIntentKey: task.openIntentKey,
          intentSummary: task.intentSummary,
          sourceMessageId: task.sourceMessageId,
          createdByApproval: task.createdByApproval,
        });
        if (paperclipIssueId) {
          next = {
            ...task,
            paperclipIssueId,
            container: deriveTaskContainer(task.source, paperclipIssueId),
            legacyLocalTerminal: false,
          };
        }
      } else if (isLegacyLocalTerminalTask(task) && task.legacyLocalTerminal !== true) {
        next = {
          ...task,
          legacyLocalTerminal: true,
        };
      } else if (task.paperclipIssueId && task.legacyLocalTerminal) {
        next = {
          ...task,
          legacyLocalTerminal: false,
        };
      }

      if (JSON.stringify(next) === JSON.stringify(task)) {
        continue;
      }
      ledger.tasks[taskId] = next;
      changed = true;
      if (next.paperclipIssueId && next.paperclipIssueId !== task.paperclipIssueId) {
        syncedTasks.push(next);
      }
    }

    if (changed) {
      await writeLedger(filePath, ledger);
      for (const task of syncedTasks) {
        await syncInboundReceiptFromChiefTask({
          cfg: params.cfg,
          task: {
            taskId: task.taskId,
            agentId: task.agentId,
            sessionKey: task.sessionKey,
            source: task.source,
            promptPreview: task.promptPreview,
            sourceMessageId: task.sourceMessageId,
            paperclipIssueId: task.paperclipIssueId,
            receiptId: task.receiptId,
            status: task.status,
            phase: task.phase,
            lastProgressAt: task.lastProgressAt,
            lastError: task.lastError,
            runAttempts: task.runAttempts,
            recoveryCount: task.recoveryCount,
            threadKey: task.threadKey,
            continuityDecision: task.continuityDecision,
            openIntentKey: task.openIntentKey,
            createdByApproval: task.createdByApproval,
          },
        });
        const syncOutcome = await syncPaperclipIssueForTask(task);
        const syncedTask = applyPaperclipSyncOutcome(task, syncOutcome);
        if (syncedTask !== task) {
          ledger.tasks[task.taskId] = syncedTask;
          changed = true;
        }
      }
      if (changed) {
        await writeLedger(filePath, ledger);
      }
    }

    return ledger;
  });
}

export async function archiveChiefTaskLedger(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  nowMs?: number;
  retentionDays?: number;
}): Promise<ChiefTaskLedgerArchiveResult> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  if (!isChiefAgentId(agentId)) {
    return {
      archivePath: resolveChiefTaskLedgerArchivePath(params.cfg, agentId),
      archivedTaskIds: [],
      archivedLegacyTerminalCount: 0,
      retainedLegacyLocalTerminalCount: 0,
      archiveLastRunAt: params.nowMs ?? Date.now(),
      archiveLastOutcome: "skipped_non_chief_agent",
      ledger: createEmptyLedger(),
      archive: createEmptyArchive(),
    };
  }
  const nowMs = params.nowMs ?? Date.now();
  const retentionDays = Math.max(1, params.retentionDays ?? DEFAULT_CHIEF_TASK_LEDGER_ARCHIVE_RETENTION_DAYS);
  const olderThanMs = retentionDays * 24 * 60 * 60 * 1000;
  const ledgerPath = resolveChiefTaskLedgerPath(params.cfg, agentId);
  const archivePath = resolveChiefTaskLedgerArchivePath(params.cfg, agentId);
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(ledgerPath);
    const archive = await loadArchive(archivePath);
    archive.archiveRetentionDays = retentionDays;
    const archivedTaskIds: string[] = [];
    const nextLedger: ChiefTaskLedger = {
      ...ledger,
      activeBySessionKey: { ...ledger.activeBySessionKey },
      tasks: { ...ledger.tasks },
    };
    const nextArchive: ChiefTaskLedgerArchive = {
      ...archive,
      archivedTasks: { ...archive.archivedTasks },
    };

    for (const [taskId, task] of Object.entries(ledger.tasks)) {
      if (!isArchiveEligibleLegacyLocalTerminalTask(task, nowMs, olderThanMs)) {
        continue;
      }
      nextArchive.archivedTasks[taskId] = {
        task,
        archivedAt: nowMs,
        archiveReason: "legacy_local_terminal_retention",
      };
      delete nextLedger.tasks[taskId];
      archivedTaskIds.push(taskId);
      clearSessionActiveMapping(nextLedger, task.sessionKey, taskId);
    }

    nextArchive.archiveLastRunAt = nowMs;
    nextArchive.archiveLastOutcome =
      archivedTaskIds.length > 0 ? `archived_${archivedTaskIds.length}` : "no_action";

    if (archivedTaskIds.length > 0) {
      await writeLedger(ledgerPath, nextLedger);
    }
    await writeArchive(archivePath, nextArchive);

    const retainedLegacyLocalTerminalCount = Object.values(nextLedger.tasks).filter(
      (task) => task.legacyLocalTerminal === true,
    ).length;
    return {
      archivePath,
      archivedTaskIds,
      archivedLegacyTerminalCount: Object.keys(nextArchive.archivedTasks).length,
      retainedLegacyLocalTerminalCount,
      archiveLastRunAt: nextArchive.archiveLastRunAt ?? nowMs,
      archiveLastOutcome: nextArchive.archiveLastOutcome ?? "no_action",
      ledger: archivedTaskIds.length > 0 ? nextLedger : ledger,
      archive: nextArchive,
    };
  });
}

export async function listStaleChiefTasks(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  staleAfterMs?: number;
  resumeCooldownMs?: number;
  nowMs?: number;
}): Promise<ChiefTaskRecord[]> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  if (!isChiefAgentId(agentId)) {
    return [];
  }
  const filePath = resolveChiefTaskLedgerPath(params.cfg, agentId);
  const nowMs = params.nowMs ?? Date.now();
  const staleAfterMs = params.staleAfterMs ?? CHIEF_TASK_STALE_AFTER_MS;
  const resumeCooldownMs = params.resumeCooldownMs ?? CHIEF_TASK_RESUME_COOLDOWN_MS;
  await reconcileChiefTaskAuthority({ cfg: params.cfg, agentId });
  return await withChiefTaskLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    let changed = false;
    for (const [taskId, task] of Object.entries(ledger.tasks)) {
      if (!isResumeCandidate(task.status)) {
        continue;
      }
      const reconciled = await reconcileChiefTaskFromTranscript({
        cfg: params.cfg,
        agentId,
        task,
      });
      if (JSON.stringify(reconciled) === JSON.stringify(task)) {
        continue;
      }
      ledger.tasks[taskId] = reconciled;
      changed = true;
      if (!isResumeCandidate(reconciled.status)) {
        clearSessionActiveMapping(ledger, reconciled.sessionKey, taskId);
      }
    }
    if (changed) {
      await writeLedger(filePath, ledger);
    }
    return Object.values(ledger.tasks)
      .filter((task) => isResumeCandidate(task.status))
      .filter((task) => nowMs - task.lastProgressAt >= staleAfterMs)
      .filter(
        (task) =>
          typeof task.lastResumeRequestedAt !== "number" ||
          nowMs - task.lastResumeRequestedAt >= resumeCooldownMs,
      )
      .sort((a, b) => a.lastProgressAt - b.lastProgressAt);
  });
}

export async function listChiefTaskContinuityCandidates(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  threadKey?: string;
  sessionKey?: string;
  limit?: number;
}): Promise<ChiefTaskRecord[]> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  if (!isChiefAgentId(agentId)) {
    return [];
  }
  const threadKey = normalizeThreadKey(params.threadKey, params.sessionKey);
  const limit = Math.max(1, params.limit ?? 25);
  const ledger = await loadLedger(resolveChiefTaskLedgerPath(params.cfg, agentId));
  return Object.values(ledger.tasks)
    .filter((task) => isContinuableTaskStatus(task.status))
    .filter((task) => !threadKey || task.threadKey === threadKey)
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt)
    .slice(0, limit);
}

export async function loadChiefTaskLedgerForTest(filePath: string): Promise<ChiefTaskLedger> {
  return await loadLedger(filePath);
}

export async function loadChiefTaskLedgerArchiveForTest(filePath: string): Promise<ChiefTaskLedgerArchive> {
  return await loadArchive(filePath);
}

export async function loadChiefRuntimeState(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<ChiefRuntimeState> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  const ledger = normalizeLedger(await reconcileChiefTaskAuthority({ cfg: params.cfg, agentId }));
  return summarizeChiefRuntimeState(ledger, Date.now());
}
