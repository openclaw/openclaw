import { resetToolStream } from "../app-tool-stream.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../chat/attachment-payload-store.ts";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "../chat/heartbeat-display.ts";
import { extractText } from "../chat/message-extract.ts";
import type { ChatRunStatus } from "../chat/run-status.ts";
import { formatConnectError } from "../connect-error.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const CHAT_HISTORY_REQUEST_LIMIT = 100;
const CHAT_HISTORY_REQUEST_MAX_CHARS = 4_000;
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;
const CHAT_HISTORY_TARGET_REQUEST_LIMIT = 200;
const chatHistoryRequestVersions = new WeakMap<object, number>();

function beginChatHistoryRequest(state: ChatState): number {
  const key = state as object;
  const nextVersion = (chatHistoryRequestVersions.get(key) ?? 0) + 1;
  chatHistoryRequestVersions.set(key, nextVersion);
  return nextVersion;
}

function isLatestChatHistoryRequest(state: ChatState, version: number): boolean {
  return chatHistoryRequestVersions.get(state as object) === version;
}

function shouldApplyChatHistoryResult(
  state: ChatState,
  version: number,
  sessionKey: string,
): boolean {
  return isLatestChatHistoryRequest(state, version) && state.sessionKey === sessionKey;
}

function isSilentReplyStream(text: string): boolean {
  return SILENT_REPLY_PATTERN.test(text);
}

/** Client-side defense-in-depth: detect assistant messages whose text is purely NO_REPLY. */
function isAssistantSilentReply(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  // entry.text takes precedence — matches gateway extractAssistantTextForSilentCheck
  if (typeof entry.text === "string") {
    return isSilentReplyStream(entry.text);
  }
  const text = extractText(message);
  return typeof text === "string" && isSilentReplyStream(text);
}

function isSyntheticTranscriptRepairToolResult(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "toolresult") {
    return false;
  }
  const text = extractText(message);
  return typeof text === "string" && text.trim() === SYNTHETIC_TRANSCRIPT_REPAIR_RESULT;
}

function isTextOnlyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  if (content.length === 0) {
    return true;
  }
  let sawText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (entry.type !== "text") {
      return false;
    }
    sawText = true;
    if (typeof entry.text !== "string") {
      return false;
    }
  }
  return sawText;
}

function isEmptyUserTextOnlyMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  if (normalizeLowercaseStringOrEmpty(entry.role) !== "user") {
    return false;
  }
  if (!isTextOnlyContent(entry.content ?? entry.text)) {
    return false;
  }
  return (extractText(message)?.trim() ?? "") === "";
}

function isHeartbeatAckStream(text: string): boolean {
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}

function shouldHideAssistantChatMessage(message: unknown): boolean {
  return isAssistantSilentReply(message) || isAssistantHeartbeatAckForDisplay(message);
}

function shouldHideHistoryMessage(message: unknown): boolean {
  return (
    shouldHideAssistantChatMessage(message) ||
    isSyntheticTranscriptRepairToolResult(message) ||
    isEmptyUserTextOnlyMessage(message)
  );
}

function hasTranscriptMeta(message: unknown): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as { __openclaw?: unknown }).__openclaw &&
    typeof (message as { __openclaw?: unknown }).__openclaw === "object",
  );
}

function isLocallyOptimisticHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object" || hasTranscriptMeta(message)) {
    return false;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  return role === "user" || role === "assistant";
}

function messageDisplaySignature(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const role = normalizeLowercaseStringOrEmpty((message as { role?: unknown }).role);
  if (!role) {
    return null;
  }
  const text = extractText(message)?.trim();
  if (text) {
    return `${role}:text:${text}`;
  }
  try {
    const content = JSON.stringify((message as { content?: unknown }).content ?? null);
    return `${role}:content:${content}`;
  } catch {
    return null;
  }
}

export function preserveOptimisticTailMessages(
  historyMessages: unknown[],
  previousMessages: unknown[],
): unknown[] {
  if (previousMessages.length === 0) {
    return historyMessages;
  }
  if (historyMessages.length === 0) {
    const optimisticMessages = previousMessages.filter(
      (message) => isLocallyOptimisticHistoryMessage(message) && !shouldHideHistoryMessage(message),
    );
    return optimisticMessages.length === previousMessages.length
      ? previousMessages
      : historyMessages;
  }
  const historySignatureIndexes = new Map<string, number>();
  historyMessages.forEach((message, index) => {
    const signature = messageDisplaySignature(message);
    if (signature) {
      historySignatureIndexes.set(signature, index);
    }
  });
  let sharedPreviousIndex = -1;
  let sharedHistoryIndex = -1;
  for (let index = previousMessages.length - 1; index >= 0; index--) {
    const signature = messageDisplaySignature(previousMessages[index]);
    const historyIndex = signature ? historySignatureIndexes.get(signature) : undefined;
    if (typeof historyIndex === "number") {
      sharedPreviousIndex = index;
      sharedHistoryIndex = historyIndex;
      break;
    }
  }
  if (sharedPreviousIndex < 0) {
    return historyMessages;
  }
  if (sharedHistoryIndex < historyMessages.length - 1) {
    return historyMessages;
  }
  const optimisticTail: unknown[] = [];
  for (const message of previousMessages.slice(sharedPreviousIndex + 1)) {
    if (!isLocallyOptimisticHistoryMessage(message) || shouldHideHistoryMessage(message)) {
      return historyMessages;
    }
    const signature = messageDisplaySignature(message);
    if (!signature || historySignatureIndexes.has(signature)) {
      return historyMessages;
    }
    optimisticTail.push(message);
  }
  return optimisticTail.length > 0 ? [...historyMessages, ...optimisticTail] : historyMessages;
}

function isRetryableStartupUnavailable(err: unknown, method: string): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function resolveStartupRetryDelayMs(err: GatewayRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ChatTaskSummary = {
  status?: string;
  runId?: string;
  taskId?: string;
  terminalSummary?: string;
  blockedReason?: string;
  error?: string;
};

type ChatSendAck = {
  runId?: string;
  status?: string;
  taskId?: string;
};

type ChatRunTaskProbe =
  | { state: "active" | "unknown" }
  | { state: "terminal"; task: ChatTaskSummary };

function isTerminalTaskStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "blocked" ||
    status === "failed" ||
    status === "timed_out" ||
    status === "cancelled"
  );
}

async function probeChatRunTask(state: ChatState, runId: string | null): Promise<ChatRunTaskProbe> {
  if (!runId || !state.client || !state.connected) {
    return { state: "unknown" };
  }
  try {
    const res = await state.client.request<{ tasks?: ChatTaskSummary[] }>("tasks.list", {
      sessionKey: state.sessionKey,
      runId,
      limit: 1,
    });
    const task = Array.isArray(res.tasks) ? res.tasks[0] : undefined;
    if (!task) {
      return { state: "unknown" };
    }
    if (task.taskId && !state.chatTaskId) {
      state.chatTaskId = task.taskId;
    }
    const status = typeof task.status === "string" ? task.status : undefined;
    if (status === "queued" || status === "running") {
      return { state: "active" };
    }
    if (isTerminalTaskStatus(status)) {
      return { state: "terminal", task };
    }
  } catch {
    return { state: "unknown" };
  }
  return { state: "unknown" };
}

function applyTerminalTaskRunStatus(state: ChatState, runId: string, task: ChatTaskSummary) {
  const status = task.status;
  const detail = task.blockedReason ?? task.error ?? task.terminalSummary;
  state.chatRunId = null;
  state.chatTaskId = task.taskId ?? state.chatTaskId ?? null;
  state.chatStream = null;
  state.chatStreamStartedAt = null;
  if (status === "completed") {
    state.chatRunStatus = { phase: "complete", runId, updatedAt: Date.now() };
    return;
  }
  if (status === "cancelled") {
    state.chatRunStatus = { phase: "aborted", runId, updatedAt: Date.now() };
    return;
  }
  state.chatRunStatus = {
    phase: "error",
    runId,
    detail: status === "blocked" ? detail || "Needs attention" : detail || status || "error",
    updatedAt: Date.now(),
  };
}

export type ChatState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  currentSessionId?: string | null;
  chatLoading: boolean;
  chatMessages: unknown[];
  chatThinkingLevel: string | null;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatRunId: string | null;
  chatTaskId?: string | null;
  chatTargetStatus?: "exact-run" | "timestamp-fallback" | "not-found" | null;
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunStatus?: ChatRunStatus | null;
  lastError: string | null;
  resetChatInputHistoryNavigation?: () => void;
};

export type ChatEventPayload = {
  runId?: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  errorMessage?: string;
};

function maybeResetToolStream(state: ChatState) {
  const toolHost = state as ChatState & Partial<Parameters<typeof resetToolStream>[0]>;
  if (
    toolHost.toolStreamById instanceof Map &&
    Array.isArray(toolHost.toolStreamOrder) &&
    Array.isArray(toolHost.chatToolMessages) &&
    Array.isArray(toolHost.chatStreamSegments)
  ) {
    resetToolStream(toolHost as Parameters<typeof resetToolStream>[0]);
  }
}

export async function loadChatHistory(
  state: ChatState,
  opts?: { targetRunId?: string | null; auditTs?: number | null; quiet?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = state.sessionKey;
  const activeRunIdBeforeRequest = state.chatRunId;
  const targetRunId = opts?.targetRunId ?? activeRunIdBeforeRequest ?? null;
  const targetedRequest =
    Boolean(targetRunId) || (typeof opts?.auditTs === "number" && Number.isFinite(opts.auditTs));
  const taskProbe =
    targetRunId && state.chatRunId === targetRunId
      ? await probeChatRunTask(state, targetRunId)
      : { state: "unknown" as const };
  if (taskProbe.state === "active") {
    return;
  }
  const requestVersion = beginChatHistoryRequest(state);
  const startedAt = Date.now();
  const previousMessages = state.chatMessages;
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  if (!opts?.quiet) {
    state.chatLoading = true;
  }
  if (!opts?.quiet) {
    state.lastError = null;
  }
  try {
    let res: {
      messages?: Array<unknown>;
      sessionId?: string;
      thinkingLevel?: string;
      targetStatus?: "exact-run" | "timestamp-fallback" | "not-found";
    };
    for (;;) {
      try {
        res = await state.client.request<{
          messages?: Array<unknown>;
          sessionId?: string;
          thinkingLevel?: string;
          targetStatus?: "exact-run" | "timestamp-fallback" | "not-found";
        }>("chat.history", {
          sessionKey,
          limit: targetedRequest ? CHAT_HISTORY_TARGET_REQUEST_LIMIT : CHAT_HISTORY_REQUEST_LIMIT,
          maxChars: CHAT_HISTORY_REQUEST_MAX_CHARS,
          ...(targetRunId ? { targetRunId } : {}),
          ...(typeof opts?.auditTs === "number" && Number.isFinite(opts.auditTs)
            ? { auditTs: opts.auditTs }
            : {}),
        });
        break;
      } catch (err) {
        if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
          return;
        }
        const withinStartupRetryWindow =
          Date.now() - startedAt < STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
        if (withinStartupRetryWindow && isRetryableStartupUnavailable(err, "chat.history")) {
          await sleep(resolveStartupRetryDelayMs(err));
          if (!state.client || !state.connected) {
            return;
          }
          continue;
        }
        throw err;
      }
    }
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    const messages = Array.isArray(res.messages) ? res.messages : [];
    const visibleMessages = messages.filter((message) => !shouldHideHistoryMessage(message));
    state.chatMessages = preserveOptimisticTailMessages(visibleMessages, previousMessages);
    const completedActiveRun =
      activeRunIdBeforeRequest &&
      state.chatRunId === activeRunIdBeforeRequest &&
      hasAssistantHistoryMessageForRun(visibleMessages, activeRunIdBeforeRequest);
    if (completedActiveRun) {
      state.chatRunId = null;
      state.chatTaskId = null;
      state.chatStream = null;
      state.chatStreamStartedAt = null;
      state.chatRunStatus = {
        phase: "complete",
        runId: activeRunIdBeforeRequest,
        updatedAt: Date.now(),
      };
    } else if (targetRunId && taskProbe.state === "terminal") {
      applyTerminalTaskRunStatus(state, targetRunId, taskProbe.task);
    }
    state.currentSessionId =
      typeof res.sessionId === "string" && res.sessionId.trim() ? res.sessionId : null;
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    state.chatTargetStatus = res.targetStatus ?? null;
    maybeResetToolStream(state);
    if (!state.chatRunId) {
      // History includes completed tool results and text inline, so keeping
      // finished streaming artifacts would cause duplicates.
      state.chatStream = null;
      state.chatStreamStartedAt = null;
    }
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    if (!opts?.quiet) {
      if (isMissingOperatorReadScopeError(err)) {
        state.chatMessages = [];
        state.chatThinkingLevel = null;
        state.chatTargetStatus = null;
        state.lastError = formatMissingOperatorReadScopeMessage("existing chat history");
      } else {
        state.chatTargetStatus = null;
        state.lastError = String(err);
      }
    }
  } finally {
    if (isLatestChatHistoryRequest(state, requestVersion)) {
      state.chatLoading = false;
    }
  }
}

function getMessageRunId(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  const runId = (meta as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
}

function hasAssistantHistoryMessageForRun(messages: readonly unknown[], runId: string): boolean {
  return messages.some(
    (message) =>
      Boolean(message && typeof message === "object" && !Array.isArray(message)) &&
      (message as { role?: unknown }).role === "assistant" &&
      getMessageRunId(message) === runId,
  );
}

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

function buildApiAttachments(attachments?: ChatAttachment[]) {
  const hasAttachments = attachments && attachments.length > 0;
  return hasAttachments
    ? attachments
        .map((att) => {
          const dataUrl = getChatAttachmentDataUrl(att);
          const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: parsed.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: parsed.mimeType,
            fileName: att.fileName,
            content: parsed.content,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null)
    : undefined;
}

async function requestChatSend(
  state: ChatState,
  params: { message: string; attachments?: ChatAttachment[]; runId: string },
): Promise<ChatSendAck> {
  const sessionId =
    typeof state.currentSessionId === "string" && state.currentSessionId.trim()
      ? state.currentSessionId.trim()
      : undefined;
  return await state.client!.request<ChatSendAck>("chat.send", {
    sessionKey: state.sessionKey,
    ...(sessionId ? { sessionId } : {}),
    message: params.message,
    deliver: false,
    idempotencyKey: params.runId,
    attachments: buildApiAttachments(params.attachments),
  });
}

type AssistantMessageNormalizationOptions = {
  roleRequirement: "required" | "optional";
  roleCaseSensitive?: boolean;
  requireContentArray?: boolean;
  allowTextField?: boolean;
};

function normalizeAssistantMessage(
  message: unknown,
  options: AssistantMessageNormalizationOptions,
): Record<string, unknown> | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const candidate = message as Record<string, unknown>;
  const roleValue = candidate.role;
  if (typeof roleValue === "string") {
    const role = options.roleCaseSensitive ? roleValue : normalizeLowercaseStringOrEmpty(roleValue);
    if (role !== "assistant") {
      return null;
    }
  } else if (options.roleRequirement === "required") {
    return null;
  }

  if (options.requireContentArray) {
    return Array.isArray(candidate.content) ? candidate : null;
  }
  if (!("content" in candidate) && !(options.allowTextField && "text" in candidate)) {
    return null;
  }
  return candidate;
}

function normalizeAbortedAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "required",
    roleCaseSensitive: true,
    requireContentArray: true,
  });
}

function normalizeFinalAssistantMessage(message: unknown): Record<string, unknown> | null {
  return normalizeAssistantMessage(message, {
    roleRequirement: "optional",
    allowTextField: true,
  });
}

export async function sendChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  if (state.chatSending) {
    return state.chatRunId;
  }

  const now = Date.now();

  // Build user message content blocks
  const contentBlocks: Array<{
    type: string;
    text?: string;
    url?: string;
    source?: unknown;
    attachment?: {
      url: string;
      kind: "audio" | "document";
      label: string;
      mimeType?: string;
    };
  }> = [];
  if (msg) {
    contentBlocks.push({ type: "text", text: msg });
  }
  // Add image previews to the message for display
  if (hasAttachments) {
    for (const att of attachments) {
      const previewUrl = getChatAttachmentPreviewUrl(att);
      if (!previewUrl) {
        continue;
      }
      if (att.mimeType.startsWith("image/")) {
        contentBlocks.push({
          type: "image",
          url: previewUrl,
          source: { type: "url", url: previewUrl },
        });
        continue;
      }
      contentBlocks.push({
        type: "attachment",
        attachment: {
          url: previewUrl,
          kind: att.mimeType.startsWith("audio/") ? "audio" : "document",
          label: att.fileName?.trim() || "Attached file",
          mimeType: att.mimeType,
        },
      });
    }
  }

  state.chatMessages = [
    ...state.chatMessages,
    {
      role: "user",
      content: contentBlocks,
      timestamp: now,
    },
  ];

  state.chatSending = true;
  state.lastError = null;
  const runId = generateUUID();
  state.chatRunId = runId;
  state.chatTaskId = null;
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  state.chatRunStatus = { phase: "sent", runId, updatedAt: now };

  try {
    const ack = await requestChatSend(state, { message: msg, attachments, runId });
    if (ack.taskId) {
      state.chatTaskId = ack.taskId;
    }
    if (state.chatRunId === runId) {
      state.chatRunStatus = { phase: "received", runId, updatedAt: Date.now() };
    }
    return runId;
  } catch (err) {
    const error = formatConnectError(err);
    state.chatRunId = null;
    state.chatTaskId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.chatRunStatus = { phase: "error", runId, detail: error, updatedAt: Date.now() };
    state.lastError = error;
    state.chatMessages = [
      ...state.chatMessages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Error: " + error }],
        timestamp: Date.now(),
      },
    ];
    return null;
  } finally {
    state.chatSending = false;
  }
}

export async function sendDetachedChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  state.lastError = null;
  const runId = generateUUID();
  try {
    await requestChatSend(state, { message: msg, attachments, runId });
    return runId;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return null;
  }
}

export async function sendSteerChatMessage(
  state: ChatState,
  message: string,
  attachments?: ChatAttachment[],
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const msg = message.trim();
  const hasAttachments = attachments && attachments.length > 0;
  if (!msg && !hasAttachments) {
    return null;
  }
  state.lastError = null;
  const runId = generateUUID();
  try {
    await requestChatSend(state, { message: msg, attachments, runId });
    return runId;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return null;
  }
}

export async function abortChatRun(state: ChatState): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  const runId = state.chatRunId;
  try {
    await state.client.request(
      "chat.abort",
      runId ? { sessionKey: state.sessionKey, runId } : { sessionKey: state.sessionKey },
    );
    return true;
  } catch (err) {
    state.lastError = formatConnectError(err);
    return false;
  }
}

export function handleChatEvent(state: ChatState, payload?: ChatEventPayload) {
  if (!payload) {
    return null;
  }
  const sessionMatches = payload.sessionKey === state.sessionKey;
  const activeRunMatches =
    state.chatRunId !== null &&
    typeof payload.runId === "string" &&
    payload.runId === state.chatRunId;
  if (!sessionMatches && !activeRunMatches) {
    return null;
  }

  // Terminal events for the active client run carry runId; missing-runId events are unowned.
  // Final from another run (e.g. sub-agent announce): refresh history to show new message.
  // See https://github.com/openclaw/openclaw/issues/1909
  if (state.chatRunId && payload.runId !== state.chatRunId) {
    if (payload.state === "final") {
      const finalMessage = normalizeFinalAssistantMessage(payload.message);
      if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (
      typeof next === "string" &&
      !isSilentReplyStream(next) &&
      !isAssistantHeartbeatAckForDisplay(payload.message)
    ) {
      state.chatStream = next;
      state.chatRunStatus = {
        phase: "replying",
        runId: payload.runId ?? state.chatRunId,
        updatedAt: Date.now(),
      };
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    } else if (
      state.chatStream?.trim() &&
      !isSilentReplyStream(state.chatStream) &&
      !isHeartbeatAckStream(state.chatStream)
    ) {
      state.chatMessages = [
        ...state.chatMessages,
        {
          role: "assistant",
          content: [{ type: "text", text: state.chatStream }],
          timestamp: Date.now(),
        },
      ];
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatTaskId = null;
    state.chatStreamStartedAt = null;
    state.chatRunStatus = { phase: "complete", runId: payload.runId, updatedAt: Date.now() };
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !shouldHideAssistantChatMessage(normalizedMessage)) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      const streamedText = state.chatStream ?? "";
      if (
        streamedText.trim() &&
        !isSilentReplyStream(streamedText) &&
        !isHeartbeatAckStream(streamedText)
      ) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatTaskId = null;
    state.chatStreamStartedAt = null;
    state.chatRunStatus = { phase: "aborted", runId: payload.runId, updatedAt: Date.now() };
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatTaskId = null;
    state.chatStreamStartedAt = null;
    state.lastError = payload.errorMessage ?? "chat error";
    state.chatRunStatus = {
      phase: "error",
      runId: payload.runId,
      detail: payload.errorMessage ?? "chat error",
      updatedAt: Date.now(),
    };
  }
  return payload.state;
}
