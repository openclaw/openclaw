import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "./json-files.js";

export const INBOUND_RECEIPT_LEDGER_VERSION = 1;
export const INBOUND_RECEIPT_STALE_AFTER_MS = 5 * 60_000;

const INBOUND_RECEIPT_LEDGER_FILENAME = "inbound-receipt-ledger.json";
const INBOUND_RECEIPT_RUNTIME_STATE_FILENAME = "inbound-receipt-runtime-state.json";

export type InboundReceiptSourceType = "telegram" | "paperclip";
export type InboundReceiptContinuityDecision =
  | "direct_answer"
  | "attach_existing_task"
  | "new_task_candidate";
export type InboundReceiptProposalStatus =
  | "none"
  | "pending_confirmation"
  | "approved"
  | "declined";
export type InboundReceiptStatus =
  | "received"
  | "acked"
  | "task_created"
  | "executing"
  | "reviewing"
  | "awaiting_input"
  | "blocked"
  | "done"
  | "ignored";

export type InboundReceiptRecord = {
  receiptId: string;
  channel: string;
  accountId?: string;
  originatingTo?: string;
  messageId: string;
  sessionKey?: string;
  agentId: string;
  sourceType: InboundReceiptSourceType;
  receivedAt: number;
  bodyPreview?: string;
  taskId?: string;
  status: InboundReceiptStatus;
  ignoreReason?: string;
  lastProgressAt: number;
  lastError?: string;
  recoveryCount: number;
  replayedAt?: number;
  completedAt?: number;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  bodyText?: string;
  threadKey?: string;
  senderId?: string;
  senderUsername?: string;
  continuityDecision?: InboundReceiptContinuityDecision;
  proposalStatus?: InboundReceiptProposalStatus;
  proposedTaskIntentKey?: string;
  matchedTaskId?: string;
  matchedPaperclipIssueId?: string;
  openIntentKey?: string;
  continuityReasonCodes?: string[];
  continuityConfidence?: number;
  proposalMessageId?: string;
  proposalPreview?: string;
};

type InboundReceiptLedger = {
  version: number;
  receipts: Record<string, InboundReceiptRecord>;
};

export type InboundReceiptReplayCandidate = {
  receiptId: string;
  sourceType: InboundReceiptSourceType;
  status: InboundReceiptStatus;
  agentId: string;
  sessionKey?: string;
  taskId?: string;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  staleForMs: number;
  recoveryCount: number;
  lastProgressAt: number;
};

export type InboundReceiptRuntimeState = {
  version: number;
  generatedAt: number;
  totalReceiptCount: number;
  unfinishedReceiptCount: number;
  oldestUnfinishedReceiptAgeMs: number | null;
  actionableReceiptCount: number;
  oldestActionableReceiptAgeMs: number | null;
  visibleWaitingReceiptCount: number;
  awaitingConfirmationCount: number;
  replayQueueCount: number;
  oldestReplayCandidateAgeMs: number | null;
  countsByStatus: Record<InboundReceiptStatus, number>;
  replayCandidates: InboundReceiptReplayCandidate[];
};

type ReceiptTaskSync = {
  taskId: string;
  agentId: string;
  sessionKey: string;
  source: "telegram" | "paperclip" | "direct" | "internal" | "unknown";
  promptPreview?: string;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  receiptId?: string;
  status?: "in_progress" | "stalled" | "awaiting_input" | "blocked" | "done";
  phase?:
    | "queued"
    | "triaged"
    | "delegated"
    | "executing"
    | "reviewing"
    | "awaiting_input"
    | "blocked"
    | "done";
  lastProgressAt?: number;
  lastError?: string;
  runAttempts?: number;
  recoveryCount?: number;
  bodyText?: string;
  threadKey?: string;
  continuityDecision?: InboundReceiptContinuityDecision;
  openIntentKey?: string;
  createdByApproval?: boolean;
};

const withInboundReceiptLedgerLock = createAsyncLock();

const STATUS_ORDER: Record<InboundReceiptStatus, number> = {
  received: 0,
  acked: 1,
  task_created: 2,
  executing: 3,
  reviewing: 4,
  awaiting_input: 5,
  blocked: 6,
  done: 7,
  ignored: 7,
};

const CONTINUITY_DECISION_STRENGTH: Record<InboundReceiptContinuityDecision, number> = {
  direct_answer: 0,
  attach_existing_task: 1,
  new_task_candidate: 2,
};

function createEmptyLedger(): InboundReceiptLedger {
  return {
    version: INBOUND_RECEIPT_LEDGER_VERSION,
    receipts: {},
  };
}

function normalizePreview(value: string | undefined, maxChars = 280): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeBodyText(value: string | undefined, maxChars = 12_000): string | undefined {
  const trimmed = value?.replace(/\r\n?/g, "\n").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeThreadKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeReasonCodes(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const next = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean)
    .slice(0, 12);
  return next.length > 0 ? next : undefined;
}

function normalizeReceiptRecord(
  receiptId: string,
  record: InboundReceiptRecord,
): InboundReceiptRecord {
  return {
    ...record,
    receiptId: record.receiptId?.trim() || receiptId,
    channel: record.channel?.trim() || record.sourceType || "unknown",
    accountId: record.accountId?.trim() || undefined,
    originatingTo: record.originatingTo?.trim() || undefined,
    messageId: record.messageId?.trim() || receiptId,
    sessionKey: record.sessionKey?.trim() || undefined,
    agentId: record.agentId?.trim().toLowerCase() || "chief",
    sourceType: record.sourceType === "paperclip" ? "paperclip" : "telegram",
    receivedAt:
      typeof record.receivedAt === "number" && Number.isFinite(record.receivedAt)
        ? record.receivedAt
        : Date.now(),
    bodyPreview: normalizePreview(record.bodyPreview),
    taskId: record.taskId?.trim() || undefined,
    status: record.status ?? "received",
    ignoreReason: normalizePreview(record.ignoreReason, 220),
    lastProgressAt:
      typeof record.lastProgressAt === "number" && Number.isFinite(record.lastProgressAt)
        ? record.lastProgressAt
        : Date.now(),
    lastError: normalizePreview(record.lastError, 400),
    recoveryCount:
      typeof record.recoveryCount === "number" && Number.isFinite(record.recoveryCount)
        ? record.recoveryCount
        : 0,
    replayedAt:
      typeof record.replayedAt === "number" && Number.isFinite(record.replayedAt)
        ? record.replayedAt
        : undefined,
    completedAt:
      typeof record.completedAt === "number" && Number.isFinite(record.completedAt)
        ? record.completedAt
        : undefined,
    sourceMessageId: record.sourceMessageId?.trim() || undefined,
    paperclipIssueId: record.paperclipIssueId?.trim() || undefined,
    bodyText: normalizeBodyText(record.bodyText),
    threadKey: normalizeThreadKey(record.threadKey),
    senderId: record.senderId?.trim() || undefined,
    senderUsername: record.senderUsername?.trim() || undefined,
    continuityDecision:
      record.continuityDecision === "direct_answer" ||
      record.continuityDecision === "attach_existing_task" ||
      record.continuityDecision === "new_task_candidate"
        ? record.continuityDecision
        : undefined,
    proposalStatus:
      record.proposalStatus === "pending_confirmation" ||
      record.proposalStatus === "approved" ||
      record.proposalStatus === "declined"
        ? record.proposalStatus
        : "none",
    proposedTaskIntentKey: normalizePreview(record.proposedTaskIntentKey, 160),
    matchedTaskId: record.matchedTaskId?.trim() || undefined,
    matchedPaperclipIssueId: record.matchedPaperclipIssueId?.trim() || undefined,
    openIntentKey: normalizePreview(record.openIntentKey, 160),
    continuityReasonCodes: normalizeReasonCodes(record.continuityReasonCodes),
    continuityConfidence:
      typeof record.continuityConfidence === "number" &&
      Number.isFinite(record.continuityConfidence)
        ? Math.min(1, Math.max(0, record.continuityConfidence))
        : undefined,
    proposalMessageId: record.proposalMessageId?.trim() || undefined,
    proposalPreview: normalizePreview(record.proposalPreview, 800),
  };
}

function normalizeLedger(ledger: InboundReceiptLedger | null): InboundReceiptLedger {
  if (!ledger || typeof ledger !== "object") {
    return createEmptyLedger();
  }
  const receiptsInput =
    ledger.receipts && typeof ledger.receipts === "object" ? ledger.receipts : {};
  return {
    version: INBOUND_RECEIPT_LEDGER_VERSION,
    receipts: Object.fromEntries(
      Object.entries(receiptsInput).map(([receiptId, record]) => [
        receiptId,
        normalizeReceiptRecord(receiptId, record),
      ]),
    ),
  };
}

function isCompleteTerminalStatus(status: InboundReceiptStatus): boolean {
  return status === "done" || status === "ignored";
}

function isVisibleTerminalStatus(status: InboundReceiptStatus): boolean {
  return status === "blocked" || status === "awaiting_input";
}

function isReplayableStatus(status: InboundReceiptStatus): boolean {
  return (
    status === "received" ||
    status === "acked" ||
    status === "task_created" ||
    status === "executing" ||
    status === "reviewing"
  );
}

function isNonCompleteStatus(status: InboundReceiptStatus): boolean {
  return !isCompleteTerminalStatus(status);
}

function isAwaitingTaskConfirmation(receipt: Pick<InboundReceiptRecord, "status" | "proposalStatus">): boolean {
  return receipt.status === "awaiting_input" && receipt.proposalStatus === "pending_confirmation";
}

function chooseProgressStatus(
  current: InboundReceiptStatus | undefined,
  next: InboundReceiptStatus,
): InboundReceiptStatus {
  if (!current) {
    return next;
  }
  if (isCompleteTerminalStatus(current)) {
    return current;
  }
  if (isVisibleTerminalStatus(current) && !isCompleteTerminalStatus(next)) {
    return current;
  }
  return STATUS_ORDER[next] >= STATUS_ORDER[current] ? next : current;
}

function chooseStrongestContinuityDecision(
  current: InboundReceiptContinuityDecision | undefined,
  next: InboundReceiptContinuityDecision | undefined,
): InboundReceiptContinuityDecision | undefined {
  const currentStrength = current != null ? CONTINUITY_DECISION_STRENGTH[current] : -1;
  const nextStrength = next != null ? CONTINUITY_DECISION_STRENGTH[next] : -1;
  if (nextStrength >= currentStrength) {
    return next ?? current;
  }
  return current;
}

function summarizeRuntimeState(
  ledger: InboundReceiptLedger,
  nowMs: number,
): InboundReceiptRuntimeState {
  const countsByStatus = {
    received: 0,
    acked: 0,
    task_created: 0,
    executing: 0,
    reviewing: 0,
    awaiting_input: 0,
    blocked: 0,
    done: 0,
    ignored: 0,
  } satisfies Record<InboundReceiptStatus, number>;

  const receipts = Object.values(ledger.receipts);
  const unfinished = receipts.filter((receipt) => isNonCompleteStatus(receipt.status));
  const actionableReceipts = unfinished.filter((receipt) => isReplayableStatus(receipt.status));
  const visibleWaitingReceipts = unfinished.filter((receipt) => isVisibleTerminalStatus(receipt.status));
  const awaitingConfirmationReceipts = visibleWaitingReceipts.filter((receipt) =>
    isAwaitingTaskConfirmation(receipt),
  );
  const replayCandidates = unfinished
    .filter((receipt) => isReplayableStatus(receipt.status))
    .filter((receipt) => nowMs - receipt.lastProgressAt >= INBOUND_RECEIPT_STALE_AFTER_MS)
    .sort((a, b) => a.lastProgressAt - b.lastProgressAt)
    .map((receipt) => ({
      receiptId: receipt.receiptId,
      sourceType: receipt.sourceType,
      status: receipt.status,
      agentId: receipt.agentId,
      sessionKey: receipt.sessionKey,
      taskId: receipt.taskId,
      sourceMessageId: receipt.sourceMessageId,
      paperclipIssueId: receipt.paperclipIssueId,
      staleForMs: Math.max(0, nowMs - receipt.lastProgressAt),
      recoveryCount: receipt.recoveryCount,
      lastProgressAt: receipt.lastProgressAt,
    }));

  for (const receipt of receipts) {
    countsByStatus[receipt.status] += 1;
  }

  const oldestUnfinished = unfinished.reduce<number | null>((oldest, receipt) => {
    const age = Math.max(0, nowMs - receipt.lastProgressAt);
    return oldest == null ? age : Math.max(oldest, age);
  }, null);
  const oldestActionable = actionableReceipts.reduce<number | null>((oldest, receipt) => {
    const age = Math.max(0, nowMs - receipt.lastProgressAt);
    return oldest == null ? age : Math.max(oldest, age);
  }, null);
  const oldestReplayCandidate = replayCandidates.reduce<number | null>((oldest, receipt) => {
    return oldest == null ? receipt.staleForMs : Math.max(oldest, receipt.staleForMs);
  }, null);

  return {
    version: INBOUND_RECEIPT_LEDGER_VERSION,
    generatedAt: nowMs,
    totalReceiptCount: receipts.length,
    unfinishedReceiptCount: unfinished.length,
    oldestUnfinishedReceiptAgeMs: oldestUnfinished,
    actionableReceiptCount: actionableReceipts.length,
    oldestActionableReceiptAgeMs: oldestActionable,
    visibleWaitingReceiptCount: visibleWaitingReceipts.length,
    awaitingConfirmationCount: awaitingConfirmationReceipts.length,
    replayQueueCount: replayCandidates.length,
    oldestReplayCandidateAgeMs: oldestReplayCandidate,
    countsByStatus,
    replayCandidates,
  };
}

async function loadLedger(filePath: string): Promise<InboundReceiptLedger> {
  return normalizeLedger(await readJsonFile<InboundReceiptLedger>(filePath));
}

async function writeLedger(filePath: string, ledger: InboundReceiptLedger): Promise<void> {
  const normalized = normalizeLedger(ledger);
  await writeJsonAtomic(filePath, normalized, { trailingNewline: true });
  const runtimeStatePath = path.join(path.dirname(filePath), INBOUND_RECEIPT_RUNTIME_STATE_FILENAME);
  await writeJsonAtomic(runtimeStatePath, summarizeRuntimeState(normalized, Date.now()), {
    trailingNewline: true,
  });
}

function derivePaperclipIssueId(sessionKey: string | undefined): string | undefined {
  const match = sessionKey?.match(/paperclip:issue:([^:]+)/i);
  return match?.[1]?.trim() || undefined;
}

function buildPaperclipTurnId(params: {
  issueId: string;
  sessionKey?: string;
  sourceMessageId?: string;
}): string {
  return params.sourceMessageId?.trim() || params.sessionKey?.trim() || params.issueId.trim();
}

export function buildTelegramInboundReceiptId(params: {
  accountId?: string;
  originatingTo?: string;
  messageThreadId?: string | number;
  messageId: string;
  agentId?: string;
}): string {
  const accountId = params.accountId?.trim() || "default";
  const originatingTo = params.originatingTo?.trim() || "unknown";
  const threadKey =
    params.messageThreadId != null && String(params.messageThreadId).trim()
      ? String(params.messageThreadId).trim()
      : "main";
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  return `telegram|${accountId}|${originatingTo}|${threadKey}|${params.messageId.trim()}|${agentId}`;
}

export function buildPaperclipInboundReceiptId(params: {
  issueId: string;
  turnId: string;
}): string {
  return `paperclip|${params.issueId.trim()}|${params.turnId.trim()}`;
}

export function resolveInboundReceiptLedgerPath(
  cfg: OpenClawConfig,
  agentId = "chief",
): string {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return path.join(path.dirname(storePath), INBOUND_RECEIPT_LEDGER_FILENAME);
}

export function resolveInboundReceiptRuntimeStatePath(
  cfg: OpenClawConfig,
  agentId = "chief",
): string {
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return path.join(path.dirname(storePath), INBOUND_RECEIPT_RUNTIME_STATE_FILENAME);
}

async function upsertReceipt(
  filePath: string,
  receiptId: string,
  updater: (existing: InboundReceiptRecord | undefined, nowMs: number) => InboundReceiptRecord | null,
): Promise<InboundReceiptRecord | null> {
  return await withInboundReceiptLedgerLock(async () => {
    const ledger = await loadLedger(filePath);
    const nowMs = Date.now();
    const existing = ledger.receipts[receiptId];
    const next = updater(existing, nowMs);
    if (!next) {
      return existing ?? null;
    }
    ledger.receipts[receiptId] = normalizeReceiptRecord(receiptId, next);
    await writeLedger(filePath, ledger);
    return ledger.receipts[receiptId] ?? null;
  });
}

export async function recordInboundReceiptReceived(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sourceType: InboundReceiptSourceType;
  channel: string;
  accountId?: string;
  originatingTo?: string;
  messageId: string;
  sessionKey?: string;
  bodyPreview?: string;
  messageThreadId?: string | number;
  receiptId?: string;
  sourceMessageId?: string;
  paperclipIssueId?: string;
  bodyText?: string;
  threadKey?: string;
  senderId?: string;
  senderUsername?: string;
}): Promise<InboundReceiptRecord | null> {
  const receiptId =
    params.receiptId?.trim() ||
    (params.sourceType === "paperclip" && params.paperclipIssueId
      ? buildPaperclipInboundReceiptId({
          issueId: params.paperclipIssueId,
          turnId: buildPaperclipTurnId({
            issueId: params.paperclipIssueId,
            sessionKey: params.sessionKey,
            sourceMessageId: params.sourceMessageId,
          }),
        })
      : buildTelegramInboundReceiptId({
          accountId: params.accountId,
          originatingTo: params.originatingTo,
          messageThreadId: params.messageThreadId,
          messageId: params.messageId,
          agentId: params.agentId,
        }));
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, params.agentId);
  return await upsertReceipt(filePath, receiptId, (existing, nowMs) => ({
    receiptId,
    channel: params.channel,
    accountId: params.accountId?.trim() || existing?.accountId,
    originatingTo: params.originatingTo?.trim() || existing?.originatingTo,
    messageId: params.messageId.trim(),
    sessionKey: params.sessionKey?.trim() || existing?.sessionKey,
    agentId: params.agentId.trim().toLowerCase(),
    sourceType: params.sourceType,
    receivedAt: existing?.receivedAt ?? nowMs,
    bodyPreview: normalizePreview(params.bodyPreview) ?? existing?.bodyPreview,
    taskId: existing?.taskId,
    status: chooseProgressStatus(existing?.status, "received"),
    ignoreReason: existing?.ignoreReason,
    lastProgressAt: existing?.lastProgressAt ?? nowMs,
    lastError: existing?.lastError,
    recoveryCount: existing?.recoveryCount ?? 0,
    replayedAt: existing?.replayedAt,
    completedAt: existing?.completedAt,
    sourceMessageId: params.sourceMessageId?.trim() || existing?.sourceMessageId,
    paperclipIssueId: params.paperclipIssueId?.trim() || existing?.paperclipIssueId,
    bodyText: normalizeBodyText(params.bodyText) ?? existing?.bodyText,
    threadKey: normalizeThreadKey(params.threadKey) ?? existing?.threadKey,
    senderId: params.senderId?.trim() || existing?.senderId,
    senderUsername: params.senderUsername?.trim() || existing?.senderUsername,
    continuityDecision: existing?.continuityDecision,
    proposalStatus: existing?.proposalStatus ?? "none",
    proposedTaskIntentKey: existing?.proposedTaskIntentKey,
    matchedTaskId: existing?.matchedTaskId,
    matchedPaperclipIssueId: existing?.matchedPaperclipIssueId,
    openIntentKey: existing?.openIntentKey,
    continuityReasonCodes: existing?.continuityReasonCodes,
    continuityConfidence: existing?.continuityConfidence,
    proposalMessageId: existing?.proposalMessageId,
    proposalPreview: existing?.proposalPreview,
  }));
}

export async function recordInboundReceiptAcked(params: {
  cfg: OpenClawConfig;
  agentId: string;
  receiptId: string;
}): Promise<InboundReceiptRecord | null> {
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, params.agentId);
  const receiptId = params.receiptId.trim();
  return await upsertReceipt(filePath, receiptId, (existing, nowMs) => {
    if (!existing) {
      return null;
    }
    return {
      ...existing,
      status: chooseProgressStatus(existing.status, "acked"),
      lastProgressAt: nowMs,
    };
  });
}

export async function recordInboundReceiptIgnored(params: {
  cfg: OpenClawConfig;
  agentId: string;
  receiptId: string;
  ignoreReason: string;
}): Promise<InboundReceiptRecord | null> {
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, params.agentId);
  const receiptId = params.receiptId.trim();
  return await upsertReceipt(filePath, receiptId, (existing, nowMs) => {
    if (!existing) {
      return null;
    }
    return {
      ...existing,
      status: "ignored",
      ignoreReason: normalizePreview(params.ignoreReason, 220) ?? "ignored",
      lastProgressAt: nowMs,
      completedAt: nowMs,
    };
  });
}

export async function recordInboundReceiptError(params: {
  cfg: OpenClawConfig;
  agentId: string;
  receiptId: string;
  error: unknown;
}): Promise<InboundReceiptRecord | null> {
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, params.agentId);
  const receiptId = params.receiptId.trim();
  return await upsertReceipt(filePath, receiptId, (existing, nowMs) => {
    if (!existing) {
      return null;
    }
    return {
      ...existing,
      lastProgressAt: nowMs,
      lastError: normalizePreview(String(params.error), 400),
    };
  });
}

export async function recordInboundReceiptStatus(params: {
  cfg: OpenClawConfig;
  agentId: string;
  receiptId: string;
  status: InboundReceiptStatus;
  ignoreReason?: string;
  lastError?: string;
  proposalStatus?: InboundReceiptProposalStatus;
}): Promise<InboundReceiptRecord | null> {
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, params.agentId);
  const receiptId = params.receiptId.trim();
  return await upsertReceipt(filePath, receiptId, (existing, nowMs) => {
    if (!existing) {
      return null;
    }
    const terminal =
      params.status === "done" ||
      params.status === "ignored" ||
      params.status === "blocked" ||
      params.status === "awaiting_input";
    return {
      ...existing,
      status: params.status,
      ignoreReason:
        params.status === "ignored"
          ? normalizePreview(params.ignoreReason, 220) ?? existing.ignoreReason ?? "ignored"
          : existing.ignoreReason,
      lastError: normalizePreview(params.lastError, 400) ?? existing.lastError,
      lastProgressAt: nowMs,
      completedAt: terminal ? nowMs : existing.completedAt,
      proposalStatus: params.proposalStatus ?? existing.proposalStatus ?? "none",
    };
  });
}

export async function recordInboundReceiptContinuity(params: {
  cfg: OpenClawConfig;
  agentId: string;
  receiptId: string;
  threadKey?: string;
  continuityDecision?: InboundReceiptContinuityDecision;
  proposalStatus?: InboundReceiptProposalStatus;
  proposedTaskIntentKey?: string;
  matchedTaskId?: string;
  matchedPaperclipIssueId?: string;
  openIntentKey?: string;
  continuityReasonCodes?: string[];
  continuityConfidence?: number;
  bodyText?: string;
  proposalMessageId?: string;
  proposalPreview?: string;
}): Promise<InboundReceiptRecord | null> {
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, params.agentId);
  const receiptId = params.receiptId.trim();
  return await upsertReceipt(filePath, receiptId, (existing, nowMs) => {
    if (!existing) {
      return null;
    }
    const proposalStatus = params.proposalStatus ?? existing.proposalStatus ?? "none";
    return {
      ...existing,
      threadKey: normalizeThreadKey(params.threadKey) ?? existing.threadKey,
      continuityDecision: params.continuityDecision ?? existing.continuityDecision,
      proposalStatus,
      proposedTaskIntentKey:
        normalizePreview(params.proposedTaskIntentKey, 160) ?? existing.proposedTaskIntentKey,
      matchedTaskId: params.matchedTaskId?.trim() || existing.matchedTaskId,
      matchedPaperclipIssueId:
        params.matchedPaperclipIssueId?.trim() || existing.matchedPaperclipIssueId,
      openIntentKey: normalizePreview(params.openIntentKey, 160) ?? existing.openIntentKey,
      continuityReasonCodes:
        normalizeReasonCodes(params.continuityReasonCodes) ?? existing.continuityReasonCodes,
      continuityConfidence:
        typeof params.continuityConfidence === "number" &&
        Number.isFinite(params.continuityConfidence)
          ? Math.min(1, Math.max(0, params.continuityConfidence))
          : existing.continuityConfidence,
      bodyText: normalizeBodyText(params.bodyText) ?? existing.bodyText,
      proposalMessageId: params.proposalMessageId?.trim() || existing.proposalMessageId,
      proposalPreview: normalizePreview(params.proposalPreview, 800) ?? existing.proposalPreview,
      lastProgressAt: nowMs,
      status: proposalStatus === "pending_confirmation" ? "awaiting_input" : existing.status,
    };
  });
}

function inferReceiptStatusFromChiefTask(task: ReceiptTaskSync): InboundReceiptStatus {
  if (task.status === "done" || task.phase === "done") {
    return "done";
  }
  if (task.status === "awaiting_input" || task.phase === "awaiting_input") {
    return "awaiting_input";
  }
  if (task.status === "blocked" || task.phase === "blocked") {
    return "blocked";
  }
  if (task.phase === "reviewing") {
    return "reviewing";
  }
  if (task.status === "stalled") {
    return "executing";
  }
  return "executing";
}

function isTerminalReceiptStatus(status: InboundReceiptStatus | undefined): boolean {
  return Boolean(status && (isCompleteTerminalStatus(status) || isVisibleTerminalStatus(status)));
}

function shouldPreserveReceiptBinding(
  existing: InboundReceiptRecord,
  task: ReceiptTaskSync,
  nextStatus: InboundReceiptStatus,
): boolean {
  const existingTaskId = existing.taskId?.trim();
  const incomingTaskId = task.taskId.trim();
  if (!existingTaskId || existingTaskId === incomingTaskId) {
    return false;
  }
  if (isTerminalReceiptStatus(nextStatus)) {
    return false;
  }
  if (isTerminalReceiptStatus(existing.status)) {
    return true;
  }
  if (existing.sourceType !== "telegram") {
    return false;
  }
  const receiptMessageId = existing.sourceMessageId?.trim() || existing.messageId?.trim();
  const incomingSourceMessageId = task.sourceMessageId?.trim();
  if (!receiptMessageId) {
    return false;
  }
  return !incomingSourceMessageId || incomingSourceMessageId !== receiptMessageId;
}

export async function syncInboundReceiptFromChiefTask(params: {
  cfg: OpenClawConfig;
  task: ReceiptTaskSync;
  stage?: "task_created" | "executing" | "reviewing" | "awaiting_input" | "blocked" | "done";
}): Promise<InboundReceiptRecord | null> {
  const agentId = params.task.agentId.trim().toLowerCase();
  if (agentId !== "chief") {
    return null;
  }
  const explicitReceiptId = params.task.receiptId?.trim();
  const issueId =
    params.task.paperclipIssueId?.trim() || derivePaperclipIssueId(params.task.sessionKey);
  const derivedReceiptId =
    explicitReceiptId ||
    (params.task.source === "paperclip" && issueId
      ? buildPaperclipInboundReceiptId({
          issueId,
          turnId: buildPaperclipTurnId({
            issueId,
            sessionKey: params.task.sessionKey,
            sourceMessageId: params.task.sourceMessageId,
          }),
        })
      : undefined);
  if (!derivedReceiptId) {
    return null;
  }
  const filePath = resolveInboundReceiptLedgerPath(params.cfg, agentId);
  const status = params.stage ?? inferReceiptStatusFromChiefTask(params.task);
  const recoveryCount = Math.max(
    params.task.recoveryCount ?? 0,
    Math.max(0, (params.task.runAttempts ?? 1) - 1),
  );
  return await upsertReceipt(filePath, derivedReceiptId, (existing, nowMs) => {
    const base = existing ?? {
      receiptId: derivedReceiptId,
      channel: params.task.source === "paperclip" ? "paperclip" : "telegram",
      messageId: params.task.sourceMessageId?.trim() || issueId || params.task.taskId,
      sessionKey: params.task.sessionKey,
      agentId,
      sourceType: params.task.source === "paperclip" ? "paperclip" : "telegram",
      receivedAt: nowMs,
      bodyPreview: params.task.promptPreview,
      status,
      lastProgressAt: params.task.lastProgressAt ?? nowMs,
      recoveryCount,
    } satisfies InboundReceiptRecord;
    const nextStatus =
      status === "task_created"
        ? chooseProgressStatus(base.status, "task_created")
        : status;
    const preserveBinding = shouldPreserveReceiptBinding(base, params.task, nextStatus);
    const terminal = nextStatus === "done" || nextStatus === "ignored";
    const visibleTerminal = nextStatus === "blocked" || nextStatus === "awaiting_input";
    const continuityDecision = chooseStrongestContinuityDecision(
      base.continuityDecision,
      params.task.continuityDecision,
    );
    const proposalStatus =
      base.proposalStatus === "approved" ||
      base.proposalStatus === "declined" ||
      base.proposalStatus === "pending_confirmation"
        ? base.proposalStatus
        : params.task.createdByApproval === true
          ? "approved"
          : "none";
    return {
      ...base,
      channel: base.channel || (params.task.source === "paperclip" ? "paperclip" : "telegram"),
      messageId: base.messageId || params.task.sourceMessageId?.trim() || issueId || params.task.taskId,
      sessionKey: params.task.sessionKey || base.sessionKey,
      taskId: preserveBinding ? base.taskId : params.task.taskId,
      status: preserveBinding ? base.status : nextStatus,
      lastProgressAt:
        preserveBinding && isTerminalReceiptStatus(base.status)
          ? base.lastProgressAt
          : params.task.lastProgressAt ?? nowMs,
      lastError: normalizePreview(params.task.lastError, 400) ?? base.lastError,
      recoveryCount: Math.max(base.recoveryCount, recoveryCount),
      replayedAt:
        recoveryCount > 0 ? Math.max(base.replayedAt ?? 0, params.task.lastProgressAt ?? nowMs) : base.replayedAt,
      completedAt:
        preserveBinding && isTerminalReceiptStatus(base.status)
          ? base.completedAt
          : terminal || visibleTerminal
          ? Math.max(base.completedAt ?? 0, params.task.lastProgressAt ?? nowMs)
          : base.completedAt,
      bodyPreview: normalizePreview(params.task.promptPreview) ?? base.bodyPreview,
      sourceMessageId: params.task.sourceMessageId?.trim() || base.sourceMessageId,
      paperclipIssueId: preserveBinding ? base.paperclipIssueId : issueId || base.paperclipIssueId,
      bodyText: normalizeBodyText(params.task.bodyText) ?? base.bodyText,
      threadKey: normalizeThreadKey(params.task.threadKey) ?? base.threadKey,
      continuityDecision,
      proposalStatus,
      matchedTaskId: preserveBinding ? base.matchedTaskId : base.matchedTaskId ?? params.task.taskId,
      matchedPaperclipIssueId:
        preserveBinding ? base.matchedPaperclipIssueId : issueId || base.matchedPaperclipIssueId,
      openIntentKey: normalizePreview(params.task.openIntentKey, 160) ?? base.openIntentKey,
    };
  });
}

export async function loadInboundReceiptLedgerForTest(filePath: string): Promise<InboundReceiptLedger> {
  return await loadLedger(filePath);
}

export async function getInboundReceiptRecord(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  receiptId: string;
}): Promise<InboundReceiptRecord | null> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  const ledger = await loadLedger(resolveInboundReceiptLedgerPath(params.cfg, agentId));
  return ledger.receipts[params.receiptId.trim()] ?? null;
}

export async function findInboundReceiptByMessageId(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  messageId: string;
  threadKey?: string;
}): Promise<InboundReceiptRecord | null> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  const messageId = params.messageId.trim();
  const threadKey = normalizeThreadKey(params.threadKey);
  const ledger = await loadLedger(resolveInboundReceiptLedgerPath(params.cfg, agentId));
  const receipts = Object.values(ledger.receipts)
    .filter((receipt) => !threadKey || receipt.threadKey === threadKey)
    .filter(
      (receipt) =>
        receipt.messageId === messageId ||
        receipt.sourceMessageId === messageId ||
        receipt.proposalMessageId === messageId,
    )
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return receipts[0] ?? null;
}

export async function listInboundReceipts(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  threadKey?: string;
  limit?: number;
}): Promise<InboundReceiptRecord[]> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  const threadKey = normalizeThreadKey(params.threadKey);
  const limit = Math.max(1, params.limit ?? 50);
  const ledger = await loadLedger(resolveInboundReceiptLedgerPath(params.cfg, agentId));
  return Object.values(ledger.receipts)
    .filter((receipt) => !threadKey || receipt.threadKey === threadKey)
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt)
    .slice(0, limit);
}

export async function loadInboundReceiptRuntimeState(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<InboundReceiptRuntimeState> {
  const agentId = params.agentId?.trim().toLowerCase() || "chief";
  const filePath = resolveInboundReceiptRuntimeStatePath(params.cfg, agentId);
  const existing = await readJsonFile<InboundReceiptRuntimeState>(filePath);
  if (
    existing &&
    typeof existing === "object" &&
    typeof existing.actionableReceiptCount === "number" &&
    typeof existing.visibleWaitingReceiptCount === "number" &&
    typeof existing.awaitingConfirmationCount === "number"
  ) {
    return existing;
  }
  const ledger = await loadLedger(resolveInboundReceiptLedgerPath(params.cfg, agentId));
  const runtimeState = summarizeRuntimeState(ledger, Date.now());
  await writeJsonAtomic(filePath, runtimeState, { trailingNewline: true });
  return runtimeState;
}
