import { deriveSessionTotalTokens, hasNonzeroUsage, normalizeUsage } from "../agents/usage.js";
import {
  hasSqliteSessionTranscriptEvents,
  loadSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "../config/sessions/transcript-store.sqlite.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { extractToolCallNames, hasToolCall } from "../utils/transcript-tools.js";
import { stripEnvelope } from "./chat-sanitize.js";
import type { SessionPreviewItem } from "./session-utils.types.js";

export { resolveSessionTranscriptCandidates } from "./session-transcript-files.fs.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

type TailTranscriptRecord = {
  id?: string;
  parentId?: string | null;
  record: Record<string, unknown>;
};

export type ReadRecentSessionMessagesOptions = {
  agentId?: string;
  maxMessages: number;
  maxBytes?: number;
  maxLines?: number;
};

export type ReadSessionMessagesAsyncOptions =
  | {
      agentId?: string;
      mode: "full";
      reason: string;
    }
  | ({
      mode: "recent";
    } & ReadRecentSessionMessagesOptions);

type ReadRecentSessionMessagesResult = {
  messages: unknown[];
  totalMessages: number;
};

function normalizeTailEntryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function loadScopedTranscriptEvents(params: {
  agentId?: string;
  sessionId: string;
  sessionFile?: string;
}): unknown[] | undefined {
  if (!params.sessionId.trim()) {
    return undefined;
  }
  try {
    const scope = resolveSqliteSessionTranscriptScope({
      agentId: params.agentId,
      sessionId: params.sessionId,
      transcriptPath: params.sessionFile,
    });
    if (!scope || !hasSqliteSessionTranscriptEvents(scope)) {
      return undefined;
    }
    return loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  } catch {
    return undefined;
  }
}

function loadScopedTranscriptJsonLines(params: {
  agentId?: string;
  sessionId: string;
  sessionFile?: string;
}): string[] | undefined {
  return loadScopedTranscriptEvents(params)?.map((event) => JSON.stringify(event));
}

function sqliteTranscriptEventToRecord(event: unknown): TailTranscriptRecord | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const record = event as Record<string, unknown>;
  return {
    ...(normalizeTailEntryString(record.id) ? { id: normalizeTailEntryString(record.id) } : {}),
    ...(record.parentId === null
      ? { parentId: null }
      : normalizeTailEntryString(record.parentId)
        ? { parentId: normalizeTailEntryString(record.parentId) }
        : {}),
    record,
  };
}

function loadScopedTranscriptRecords(params: {
  agentId?: string;
  sessionId: string;
  sessionFile?: string;
}): TailTranscriptRecord[] | undefined {
  return loadScopedTranscriptEvents(params)?.flatMap((event) => {
    const record = sqliteTranscriptEventToRecord(event);
    return record && record.record.type !== "session" ? [record] : [];
  });
}

function tailRecordHasTreeLink(entry: TailTranscriptRecord): boolean {
  return (
    entry.record.type !== "session" &&
    typeof entry.id === "string" &&
    Object.hasOwn(entry.record, "parentId")
  );
}

function selectBoundedActiveTailRecords(entries: TailTranscriptRecord[]): TailTranscriptRecord[] {
  const byId = new Map<string, TailTranscriptRecord>();
  let leafId: string | undefined;
  for (const entry of entries) {
    if (entry.id) {
      byId.set(entry.id, entry);
    }
    if (tailRecordHasTreeLink(entry) && entry.id) {
      leafId = entry.id;
    }
  }
  if (!leafId) {
    return entries;
  }

  const selected: TailTranscriptRecord[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return [];
    }
    seen.add(currentId);
    const entry = byId.get(currentId);
    if (!entry) {
      break;
    }
    selected.push(entry);
    currentId = entry.parentId ?? undefined;
  }
  const activeBranch = selected.toReversed();
  const firstActiveRecord = activeBranch[0];
  const firstActiveIndex = firstActiveRecord ? entries.indexOf(firstActiveRecord) : -1;
  if (firstActiveIndex > 0) {
    for (let index = firstActiveIndex - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.record.type === "compaction") {
        return [entry, ...activeBranch];
      }
    }
  }
  return activeBranch;
}

function selectActiveTranscriptRecords(records: TailTranscriptRecord[]): TailTranscriptRecord[] {
  return records.some(tailRecordHasTreeLink) ? selectBoundedActiveTailRecords(records) : records;
}

function parsedSessionEntryToMessage(parsed: unknown, seq: number): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (entry.message) {
    return attachOpenClawTranscriptMeta(entry.message, {
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      seq,
    });
  }
  if (entry.type === "compaction") {
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(ts) ? ts : Date.now();
    return {
      role: "system",
      content: [{ type: "text", text: "Compaction" }],
      timestamp,
      __openclaw: {
        kind: "compaction",
        id: typeof entry.id === "string" ? entry.id : undefined,
        seq,
      },
    };
  }
  return null;
}

function transcriptRecordsToMessages(records: TailTranscriptRecord[]): unknown[] {
  const messages: unknown[] = [];
  let messageSeq = 0;
  for (const entry of records) {
    const message = parsedSessionEntryToMessage(entry.record, messageSeq + 1);
    if (message) {
      messageSeq += 1;
      messages.push(message);
    }
  }
  return messages;
}

function loadScopedSessionMessages(params: {
  agentId?: string;
  sessionId: string;
  sessionFile?: string;
}): unknown[] | undefined {
  const records = loadScopedTranscriptRecords(params);
  return records ? transcriptRecordsToMessages(selectActiveTranscriptRecords(records)) : undefined;
}

export function attachOpenClawTranscriptMeta(
  message: unknown,
  meta: Record<string, unknown>,
): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return message;
  }
  const record = message as Record<string, unknown>;
  const existing =
    record.__openclaw && typeof record.__openclaw === "object" && !Array.isArray(record.__openclaw)
      ? (record.__openclaw as Record<string, unknown>)
      : {};
  return {
    ...record,
    __openclaw: {
      ...existing,
      ...meta,
    },
  };
}

export function readSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): unknown[] {
  void storePath;
  return loadScopedSessionMessages({ sessionId, sessionFile }) ?? [];
}

export function readRecentSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: ReadRecentSessionMessagesOptions,
): unknown[] {
  void storePath;
  const maxMessages = Math.max(0, Math.floor(opts?.maxMessages ?? 0));
  if (maxMessages === 0) {
    return [];
  }
  return (
    loadScopedSessionMessages({
      agentId: opts?.agentId,
      sessionId,
      sessionFile,
    })?.slice(-maxMessages) ?? []
  );
}

export function visitSessionMessages(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  visit: (message: unknown, seq: number) => void,
): number {
  void storePath;
  const messages = loadScopedSessionMessages({ sessionId, sessionFile }) ?? [];
  for (const [index, message] of messages.entries()) {
    visit(message, index + 1);
  }
  return messages.length;
}

export function readSessionMessageCount(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
): number {
  void storePath;
  return loadScopedSessionMessages({ sessionId, sessionFile })?.length ?? 0;
}

export async function readSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadSessionMessagesAsyncOptions,
): Promise<unknown[]> {
  void storePath;
  const messages =
    loadScopedSessionMessages({ agentId: opts.agentId, sessionId, sessionFile }) ?? [];
  return opts.mode === "recent"
    ? messages.slice(-Math.max(0, Math.floor(opts.maxMessages)))
    : messages;
}

export async function visitSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  visit: (message: unknown, seq: number) => void,
  opts: { mode: "full"; reason: string; agentId?: string },
): Promise<number> {
  void storePath;
  void opts.mode;
  void opts.reason;
  const messages =
    loadScopedSessionMessages({ agentId: opts.agentId, sessionId, sessionFile }) ?? [];
  for (const [index, message] of messages.entries()) {
    visit(message, index + 1);
  }
  return messages.length;
}

export async function readSessionMessageCountAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<number> {
  void storePath;
  return loadScopedSessionMessages({ agentId, sessionId, sessionFile })?.length ?? 0;
}

export function readRecentSessionMessagesWithStats(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
): ReadRecentSessionMessagesResult {
  const totalMessages = readSessionMessageCount(sessionId, storePath, sessionFile);
  const messages = readRecentSessionMessages(sessionId, storePath, sessionFile, opts);
  const firstSeq = Math.max(1, totalMessages - messages.length + 1);
  const messagesWithSeq = messages.map((message, index) =>
    attachOpenClawTranscriptMeta(message, { seq: firstSeq + index }),
  );
  return { messages: messagesWithSeq, totalMessages };
}

export async function readRecentSessionMessagesAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  opts?: ReadRecentSessionMessagesOptions,
): Promise<unknown[]> {
  return readRecentSessionMessages(sessionId, storePath, sessionFile, opts);
}

export async function readRecentSessionMessagesWithStatsAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  opts: ReadRecentSessionMessagesOptions,
): Promise<ReadRecentSessionMessagesResult> {
  return readRecentSessionMessagesWithStats(sessionId, storePath, sessionFile, opts);
}

export function readRecentSessionTranscriptLines(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  maxLines: number;
}): { lines: string[]; totalLines: number } | null {
  void params.storePath;
  const lines = loadScopedTranscriptJsonLines({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
  });
  if (!lines) {
    return null;
  }
  const maxLines = Math.max(1, Math.floor(params.maxLines));
  return {
    lines: lines.slice(-maxLines),
    totalLines: lines.length,
  };
}

export function capArrayByJsonBytes<T>(
  items: T[],
  maxBytes: number,
): { items: T[]; bytes: number } {
  if (items.length === 0) {
    return { items, bytes: 2 };
  }
  const parts = items.map((item) => jsonUtf8Bytes(item));
  let bytes = 2 + parts.reduce((a, b) => a + b, 0) + (items.length - 1);
  let start = 0;
  while (bytes > maxBytes && start < items.length - 1) {
    bytes -= parts[start] + 1;
    start += 1;
  }
  const next = start > 0 ? items.slice(start) : items;
  return { items: next, bytes };
}

type TranscriptMessage = {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  provenance?: unknown;
};

function extractTextFromContent(content: TranscriptMessage["content"]): string | null {
  if (typeof content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(content).text.trim();
    return normalized || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") {
      const normalized = stripInlineDirectiveTagsForDisplay(part.text).text.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function extractFirstUserMessageFromTranscriptEvents(
  events: unknown[],
  opts?: { includeInterSession?: boolean },
): string | null {
  for (const event of events) {
    const msg =
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as { message?: TranscriptMessage }).message
        : undefined;
    if (msg?.role !== "user") {
      continue;
    }
    if (opts?.includeInterSession !== true && hasInterSessionUserProvenance(msg)) {
      continue;
    }
    const text = extractTextFromContent(msg.content);
    if (text) {
      return text;
    }
  }
  return null;
}

function extractLastMessagePreviewFromTranscriptEvents(events: unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const msg =
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as { message?: TranscriptMessage }).message
        : undefined;
    if (msg?.role !== "user" && msg?.role !== "assistant") {
      continue;
    }
    const text = extractTextFromContent(msg.content);
    if (text) {
      return text;
    }
  }
  return null;
}

function readSessionTitleFieldsFromScopedTranscript(
  sessionId: string,
  agentId: string | undefined,
  sessionFile: string | undefined,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  const events = loadScopedTranscriptEvents({ agentId, sessionId, sessionFile });
  if (!events) {
    return { firstUserMessage: null, lastMessagePreview: null };
  }
  return {
    firstUserMessage: extractFirstUserMessageFromTranscriptEvents(events, opts),
    lastMessagePreview: extractLastMessagePreviewFromTranscriptEvents(events),
  };
}

export function readSessionTitleFieldsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  void storePath;
  return readSessionTitleFieldsFromScopedTranscript(sessionId, agentId, sessionFile, opts);
}

export async function readSessionTitleFieldsFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  return readSessionTitleFieldsFromTranscript(sessionId, storePath, sessionFile, agentId, opts);
}

export function readFirstUserMessageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
  opts?: { includeInterSession?: boolean },
): string | null {
  void storePath;
  const events = loadScopedTranscriptEvents({ agentId, sessionId, sessionFile });
  return events ? extractFirstUserMessageFromTranscriptEvents(events, opts) : null;
}

export function readLastMessagePreviewFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  void storePath;
  const events = loadScopedTranscriptEvents({ agentId, sessionId, sessionFile });
  return events ? extractLastMessagePreviewFromTranscriptEvents(events) : null;
}

type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

function extractTranscriptUsageCost(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  const total = (cost as { total?: unknown }).total;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : undefined;
}

function resolvePositiveUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractUsageSnapshotFromTranscriptEvent(
  event: unknown,
): SessionTranscriptUsageSnapshot | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }
  const parsed = event as Record<string, unknown>;
  const message =
    parsed.message && typeof parsed.message === "object" && !Array.isArray(parsed.message)
      ? (parsed.message as Record<string, unknown>)
      : undefined;
  if (!message) {
    return null;
  }
  const role = typeof message.role === "string" ? message.role : undefined;
  if (role && role !== "assistant") {
    return null;
  }
  const usageRaw =
    message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? message.usage
      : parsed.usage && typeof parsed.usage === "object" && !Array.isArray(parsed.usage)
        ? parsed.usage
        : undefined;
  const usage = normalizeUsage(usageRaw);
  const totalTokens = resolvePositiveUsageNumber(deriveSessionTotalTokens({ usage }));
  const costUsd = extractTranscriptUsageCost(usageRaw);
  const modelProvider =
    typeof message.provider === "string"
      ? message.provider.trim()
      : typeof parsed.provider === "string"
        ? parsed.provider.trim()
        : undefined;
  const model =
    typeof message.model === "string"
      ? message.model.trim()
      : typeof parsed.model === "string"
        ? parsed.model.trim()
        : undefined;
  const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
  const hasMeaningfulUsage =
    hasNonzeroUsage(usage) ||
    typeof totalTokens === "number" ||
    (typeof costUsd === "number" && Number.isFinite(costUsd));
  const hasModelIdentity = Boolean(modelProvider || model);
  if (!hasMeaningfulUsage && !hasModelIdentity) {
    return null;
  }
  if (isDeliveryMirror && !hasMeaningfulUsage) {
    return null;
  }

  const snapshot: SessionTranscriptUsageSnapshot = {};
  if (!isDeliveryMirror) {
    if (modelProvider) {
      snapshot.modelProvider = modelProvider;
    }
    if (model) {
      snapshot.model = model;
    }
  }
  if (typeof usage?.input === "number" && Number.isFinite(usage.input)) {
    snapshot.inputTokens = usage.input;
  }
  if (typeof usage?.output === "number" && Number.isFinite(usage.output)) {
    snapshot.outputTokens = usage.output;
  }
  if (typeof usage?.cacheRead === "number" && Number.isFinite(usage.cacheRead)) {
    snapshot.cacheRead = usage.cacheRead;
  }
  if (typeof usage?.cacheWrite === "number" && Number.isFinite(usage.cacheWrite)) {
    snapshot.cacheWrite = usage.cacheWrite;
  }
  if (typeof totalTokens === "number") {
    snapshot.totalTokens = totalTokens;
    snapshot.totalTokensFresh = true;
  }
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
    snapshot.costUsd = costUsd;
  }
  return snapshot;
}

function extractAggregateUsageFromTranscriptEvents(
  events: Iterable<unknown>,
): SessionTranscriptUsageSnapshot | null {
  const snapshot: SessionTranscriptUsageSnapshot = {};
  let sawSnapshot = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let sawInputTokens = false;
  let sawOutputTokens = false;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let costUsdTotal = 0;
  let sawCost = false;

  for (const event of events) {
    const current = extractUsageSnapshotFromTranscriptEvent(event);
    if (!current) {
      continue;
    }
    sawSnapshot = true;
    if (current.modelProvider) {
      snapshot.modelProvider = current.modelProvider;
    }
    if (current.model) {
      snapshot.model = current.model;
    }
    if (typeof current.inputTokens === "number") {
      inputTokens += current.inputTokens;
      sawInputTokens = true;
    }
    if (typeof current.outputTokens === "number") {
      outputTokens += current.outputTokens;
      sawOutputTokens = true;
    }
    if (typeof current.cacheRead === "number") {
      cacheRead += current.cacheRead;
      sawCacheRead = true;
    }
    if (typeof current.cacheWrite === "number") {
      cacheWrite += current.cacheWrite;
      sawCacheWrite = true;
    }
    if (typeof current.totalTokens === "number") {
      snapshot.totalTokens = current.totalTokens;
      snapshot.totalTokensFresh = true;
    }
    if (typeof current.costUsd === "number" && Number.isFinite(current.costUsd)) {
      costUsdTotal += current.costUsd;
      sawCost = true;
    }
  }

  if (!sawSnapshot) {
    return null;
  }
  if (sawInputTokens) {
    snapshot.inputTokens = inputTokens;
  }
  if (sawOutputTokens) {
    snapshot.outputTokens = outputTokens;
  }
  if (sawCacheRead) {
    snapshot.cacheRead = cacheRead;
  }
  if (sawCacheWrite) {
    snapshot.cacheWrite = cacheWrite;
  }
  if (sawCost) {
    snapshot.costUsd = costUsdTotal;
  }
  return snapshot;
}

function extractLatestUsageFromTranscriptEvents(
  events: Iterable<unknown>,
): SessionTranscriptUsageSnapshot | null {
  let latest: SessionTranscriptUsageSnapshot | null = null;
  for (const event of events) {
    latest = extractUsageSnapshotFromTranscriptEvent(event) ?? latest;
  }
  return latest;
}

function loadUsageEvents(params: {
  sessionId: string;
  sessionFile?: string;
  agentId?: string;
}): unknown[] | undefined {
  return loadScopedTranscriptEvents(params);
}

export function readLatestSessionUsageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): SessionTranscriptUsageSnapshot | null {
  void storePath;
  const events = loadUsageEvents({ agentId, sessionId, sessionFile });
  return events ? extractAggregateUsageFromTranscriptEvents(events) : null;
}

export async function readLatestSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): Promise<SessionTranscriptUsageSnapshot | null> {
  return readLatestSessionUsageFromTranscript(sessionId, storePath, sessionFile, agentId);
}

export async function readRecentSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  void storePath;
  void maxBytes;
  const events = loadUsageEvents({ agentId, sessionId, sessionFile });
  return events ? extractLatestUsageFromTranscriptEvents(events) : null;
}

export async function readLatestRecentSessionUsageFromTranscriptAsync(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  return readRecentSessionUsageFromTranscriptAsync(
    sessionId,
    storePath,
    sessionFile,
    agentId,
    maxBytes,
  );
}

export function readRecentSessionUsageFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  void storePath;
  void maxBytes;
  const events = loadUsageEvents({ agentId, sessionId, sessionFile });
  return events ? extractAggregateUsageFromTranscriptEvents(events) : null;
}

type TranscriptContentEntry = {
  type?: string;
  text?: string;
  name?: string;
};

type TranscriptPreviewMessage = {
  role?: string;
  content?: string | TranscriptContentEntry[];
  text?: string;
  toolName?: string;
  tool_name?: string;
};

function normalizeRole(role: string | undefined, isTool: boolean): SessionPreviewItem["role"] {
  if (isTool) {
    return "tool";
  }
  switch (normalizeLowercaseStringOrEmpty(role)) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    case "tool":
      return "tool";
    default:
      return "other";
  }
}

function truncatePreviewText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 3) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - 3)}...`;
}

function extractPreviewText(message: TranscriptPreviewMessage): string | null {
  const role = normalizeLowercaseStringOrEmpty(message.role);
  if (role === "assistant") {
    const assistantText = extractAssistantVisibleText(message);
    if (assistantText) {
      const normalized = stripInlineDirectiveTagsForDisplay(assistantText).text.trim();
      return normalized ? normalized : null;
    }
    return null;
  }
  if (typeof message.content === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.content).text.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((entry) =>
        typeof entry?.text === "string" ? stripInlineDirectiveTagsForDisplay(entry.text).text : "",
      )
      .filter((text) => text.trim().length > 0);
    if (parts.length > 0) {
      return parts.join("\n").trim();
    }
  }
  if (typeof message.text === "string") {
    const normalized = stripInlineDirectiveTagsForDisplay(message.text).text.trim();
    return normalized ? normalized : null;
  }
  return null;
}

function isToolCall(message: TranscriptPreviewMessage): boolean {
  return hasToolCall(message as Record<string, unknown>);
}

function extractToolNames(message: TranscriptPreviewMessage): string[] {
  return extractToolCallNames(message as Record<string, unknown>);
}

function extractMediaSummary(message: TranscriptPreviewMessage): string | null {
  if (!Array.isArray(message.content)) {
    return null;
  }
  for (const entry of message.content) {
    const raw = normalizeLowercaseStringOrEmpty(entry?.type);
    if (!raw || raw === "text" || raw === "toolcall" || raw === "tool_call") {
      continue;
    }
    return `[${raw}]`;
  }
  return null;
}

function buildPreviewItems(
  messages: TranscriptPreviewMessage[],
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  const items: SessionPreviewItem[] = [];
  for (const message of messages) {
    const toolCall = isToolCall(message);
    const role = normalizeRole(message.role, toolCall);
    let text = extractPreviewText(message);
    if (!text) {
      const toolNames = extractToolNames(message);
      if (toolNames.length > 0) {
        const shown = toolNames.slice(0, 2);
        const overflow = toolNames.length - shown.length;
        text = `call ${shown.join(", ")}`;
        if (overflow > 0) {
          text += ` +${overflow}`;
        }
      }
    }
    if (!text) {
      text = extractMediaSummary(message);
    }
    if (!text) {
      continue;
    }
    let trimmed = text.trim();
    if (!trimmed) {
      continue;
    }
    if (role === "user") {
      trimmed = stripEnvelope(trimmed);
    }
    trimmed = truncatePreviewText(trimmed, maxChars);
    items.push({ role, text: trimmed });
  }

  if (items.length <= maxItems) {
    return items;
  }
  return items.slice(-maxItems);
}

function readRecentMessagesFromScopedTranscript(
  sessionId: string,
  agentId: string | undefined,
  sessionFile: string | undefined,
  maxMessages: number,
): TranscriptPreviewMessage[] | undefined {
  const events = loadScopedTranscriptEvents({ agentId, sessionId, sessionFile });
  if (!events) {
    return undefined;
  }
  const collected: TranscriptPreviewMessage[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const msg =
      event && typeof event === "object" && !Array.isArray(event)
        ? (event as { message?: TranscriptPreviewMessage }).message
        : undefined;
    if (msg && typeof msg === "object") {
      collected.push(msg);
      if (collected.length >= maxMessages) {
        break;
      }
    }
  }
  return collected.toReversed();
}

export function readSessionPreviewItemsFromTranscript(
  sessionId: string,
  storePath: string | undefined,
  sessionFile: string | undefined,
  agentId: string | undefined,
  maxItems: number,
  maxChars: number,
): SessionPreviewItem[] {
  void storePath;
  const boundedItems = Math.max(1, Math.min(maxItems, 50));
  const boundedChars = Math.max(20, Math.min(maxChars, 2000));
  const scopedMessages = readRecentMessagesFromScopedTranscript(
    sessionId,
    agentId,
    sessionFile,
    boundedItems,
  );
  return scopedMessages ? buildPreviewItems(scopedMessages, boundedItems, boundedChars) : [];
}
