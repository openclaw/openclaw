import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export const CHIEF_TASK_LEDGER_VERSION = 1;
export const CHIEF_TASK_STALE_AFTER_MS = 5 * 60_000;
export const CHIEF_TASK_RESUME_COOLDOWN_MS = 5 * 60_000;
const CHIEF_TASK_LEDGER_FILENAME = "chief-task-ledger.json";

export type ChiefTaskStatus =
  | "in_progress"
  | "stalled"
  | "awaiting_input"
  | "blocked"
  | "done";

export type ChiefTaskSource = "telegram" | "paperclip" | "direct" | "internal" | "unknown";

export type ChiefTaskRecord = {
  taskId: string;
  agentId: string;
  sessionKey: string;
  status: ChiefTaskStatus;
  source: ChiefTaskSource;
  title: string;
  promptPreview: string;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  lastResponsePreview?: string;
  lastError?: string;
  runAttempts: number;
  resumeAttempts: number;
  lastResumeRequestedAt?: number;
  completedAt?: number;
};

type ChiefTaskLedger = {
  version: number;
  activeBySessionKey: Record<string, string>;
  tasks: Record<string, ChiefTaskRecord>;
};

type ReplyLike = {
  text?: string;
  isError?: boolean;
  mediaUrls?: string[];
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

function normalizeTitle(prompt: string): string {
  return normalizePreview(prompt, 120) ?? "Chief task";
}

function createEmptyLedger(): ChiefTaskLedger {
  return {
    version: CHIEF_TASK_LEDGER_VERSION,
    activeBySessionKey: {},
    tasks: {},
  };
}

function normalizeLedger(ledger: ChiefTaskLedger | null): ChiefTaskLedger {
  if (!ledger || typeof ledger !== "object") {
    return createEmptyLedger();
  }
  return {
    version: CHIEF_TASK_LEDGER_VERSION,
    activeBySessionKey:
      ledger.activeBySessionKey && typeof ledger.activeBySessionKey === "object"
        ? ledger.activeBySessionKey
        : {},
    tasks: ledger.tasks && typeof ledger.tasks === "object" ? ledger.tasks : {},
  };
}

export function resolveChiefTaskLedgerPath(cfg: OpenClawConfig, agentId = "chief"): string {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return path.join(path.dirname(storePath), CHIEF_TASK_LEDGER_FILENAME);
}

async function loadLedger(filePath: string): Promise<ChiefTaskLedger> {
  return normalizeLedger(await readJsonFile<ChiefTaskLedger>(filePath));
}

async function writeLedger(filePath: string, ledger: ChiefTaskLedger): Promise<void> {
  await writeJsonAtomic(filePath, ledger, { trailingNewline: true });
}

function derivePaperclipIssueId(sessionKey: string): string | undefined {
  const match = sessionKey.match(/paperclip:issue:([^:]+)/i);
  return match?.[1]?.trim() || undefined;
}

function deriveTaskSource(params: {
  sessionKey: string;
  sourceChannel?: string;
  explicitSource?: ChiefTaskSource;
}): ChiefTaskSource {
  if (params.explicitSource) {
    return params.explicitSource;
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

export async function recordChiefTaskStart(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  prompt: string;
  sourceChannel?: string;
  sourceMessageId?: string;
  source?: ChiefTaskSource;
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
    const paperclipIssueId = derivePaperclipIssueId(sessionKey);
    const source = deriveTaskSource({
      sessionKey,
      sourceChannel: params.sourceChannel,
      explicitSource: params.source,
    });
    const existingTaskId = ledger.activeBySessionKey[sessionKey];
    const existingTask = existingTaskId ? ledger.tasks[existingTaskId] : undefined;
    const taskId =
      existingTask && isResumeCandidate(existingTask.status)
        ? existingTask.taskId
        : buildTaskId({
            sessionKey,
            source,
            sourceMessageId: params.sourceMessageId,
            paperclipIssueId,
          });
    const previous = ledger.tasks[taskId];
    const next: ChiefTaskRecord = {
      taskId,
      agentId: params.agentId.trim().toLowerCase(),
      sessionKey,
      status: "in_progress",
      source,
      title: normalizeTitle(params.prompt),
      promptPreview: normalizePreview(params.prompt) ?? "Chief task",
      createdAt: previous?.createdAt ?? nowMs,
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      sourceMessageId: params.sourceMessageId?.trim() || previous?.sourceMessageId,
      paperclipIssueId: paperclipIssueId ?? previous?.paperclipIssueId,
      lastResponsePreview: previous?.lastResponsePreview,
      lastError: previous?.lastError,
      runAttempts: (previous?.runAttempts ?? 0) + 1,
      resumeAttempts: previous?.resumeAttempts ?? 0,
      lastResumeRequestedAt: previous?.lastResumeRequestedAt,
    };
    ledger.tasks[taskId] = next;
    ledger.activeBySessionKey[sessionKey] = taskId;
    await writeLedger(filePath, ledger);
    return next;
  });
}

export async function recordChiefTaskResult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId?: string;
  sessionKey: string;
  payloads?: ReplyLike[];
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
    const payloads = params.payloads ?? [];
    const preview = normalizePreview(
      payloads
        .map((payload) => payload.text?.trim())
        .filter((value): value is string => Boolean(value))
        .join("\n"),
    );
    const status = inferChiefTaskStatusFromPayloads(payloads);
    const next: ChiefTaskRecord = {
      ...task,
      status,
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      lastResponsePreview: preview ?? task.lastResponsePreview,
      ...(status === "done" ? { completedAt: nowMs } : {}),
      ...(status === "done" ? { lastError: undefined } : {}),
    };
    ledger.tasks[taskId] = next;
    if (!isResumeCandidate(status)) {
      clearSessionActiveMapping(ledger, sessionKey, taskId);
    } else {
      ledger.activeBySessionKey[sessionKey] = taskId;
    }
    await writeLedger(filePath, ledger);
    return next;
  });
}

export async function recordChiefTaskFailure(params: {
  cfg: OpenClawConfig;
  agentId: string;
  taskId?: string;
  sessionKey: string;
  error: unknown;
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
      updatedAt: nowMs,
      lastProgressAt: nowMs,
      lastError: normalizePreview(String(params.error), 400),
    };
    ledger.tasks[taskId] = next;
    ledger.activeBySessionKey[sessionKey] = taskId;
    await writeLedger(filePath, ledger);
    return next;
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
    };
    ledger.tasks[params.taskId] = next;
    await writeLedger(filePath, ledger);
    return next;
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
  const ledger = await loadLedger(filePath);
  return Object.values(ledger.tasks)
    .filter((task) => isResumeCandidate(task.status))
    .filter((task) => nowMs - task.lastProgressAt >= staleAfterMs)
    .filter(
      (task) =>
        typeof task.lastResumeRequestedAt !== "number" ||
        nowMs - task.lastResumeRequestedAt >= resumeCooldownMs,
    )
    .sort((a, b) => a.lastProgressAt - b.lastProgressAt);
}

export async function loadChiefTaskLedgerForTest(filePath: string): Promise<ChiefTaskLedger> {
  return await loadLedger(filePath);
}
