import { resetToolStream } from "../app-tool-stream.ts";
import {
  getChatAttachmentDataUrl,
  getChatAttachmentPreviewUrl,
} from "../chat/attachment-payload-store.ts";
import { extractText } from "../chat/message-extract.ts";
import { formatConnectError } from "../connect-error.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type { ChatAttachment } from "../ui-types.ts";
import { generateUUID } from "../uuid.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;
const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;
const SYNTHETIC_TRANSCRIPT_REPAIR_RESULT =
  "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHeartbeatTokenForDisplay(
  raw: string,
  maxAckChars = DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
): { shouldSkip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { shouldSkip: true };
  }
  const strippedMarkup = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "");
  if (!text.includes(HEARTBEAT_TOKEN) && !strippedMarkup.includes(HEARTBEAT_TOKEN)) {
    return { shouldSkip: false };
  }

  const tokenAtEnd = new RegExp(`${escapeRegExp(HEARTBEAT_TOKEN)}[^\\w]{0,4}$`);
  let changed = true;
  let didStrip = false;
  text = strippedMarkup.trim();
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(HEARTBEAT_TOKEN)) {
      text = next.slice(HEARTBEAT_TOKEN.length).trimStart();
      didStrip = true;
      changed = true;
      continue;
    }
    if (tokenAtEnd.test(next)) {
      const index = next.lastIndexOf(HEARTBEAT_TOKEN);
      const before = next.slice(0, index).trimEnd();
      const after = next.slice(index + HEARTBEAT_TOKEN.length).trimStart();
      text = before ? `${before}${after}`.trimEnd() : "";
      didStrip = true;
      changed = true;
    }
  }

  if (!didStrip) {
    return { shouldSkip: false };
  }
  return { shouldSkip: !text || text.length <= maxAckChars };
}

function isHeartbeatOkResponse(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  return stripHeartbeatTokenForDisplay(text).shouldSkip;
}

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      if (!block || typeof block !== "object" || !("type" in block)) {
        hasNonTextContent = true;
        return false;
      }
      if ((block as { type?: unknown }).type !== "text") {
        hasNonTextContent = true;
        return false;
      }
      if (typeof (block as { text?: unknown }).text !== "string") {
        hasNonTextContent = true;
        return false;
      }
      return true;
    })
    .map((block) => block.text)
    .join("");
  return { text, hasNonTextContent };
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

function isAssistantHeartbeatAck(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeLowercaseStringOrEmpty(entry.role);
  if (role !== "assistant") {
    return false;
  }
  const content = entry.content ?? entry.text;
  return isHeartbeatOkResponse({ role, content });
}

function shouldHideHistoryMessage(message: unknown): boolean {
  return (
    isAssistantSilentReply(message) ||
    isAssistantHeartbeatAck(message) ||
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
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  /**
   * Cumulative length of the upstream full-snapshot text that has already
   * been committed to `chatStreamSegments` by the tool-stream handler at
   * each tool boundary. Chat deltas from the gateway are full snapshots
   * (pre-tool + post-tool), so when this is `> 0`, `handleChatEvent` slices
   * off the leading `chatStreamCommittedLen` characters before assigning to
   * `chatStream`. Without this, the pre-tool prefix would render twice
   * (once in the committed segment above the tool card, once in the active
   * stream below it). Reset to 0 on chat run termination.
   */
  chatStreamCommittedLen?: number;
  /**
   * Optional view of the tool-stream handler's committed pre-tool segments.
   * `handleChatEvent` reads this on `final` / `aborted` fallbacks (when the
   * payload carries no `message` and we have to persist the streamed text)
   * so the prepended segments are not lost; only the post-tool slice lives
   * in `chatStream` after a tool boundary.
   */
  chatStreamSegments?: Array<{ text: string; ts: number }>;
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

export async function loadChatHistory(state: ChatState) {
  if (!state.client || !state.connected) {
    return;
  }
  const sessionKey = state.sessionKey;
  const requestVersion = beginChatHistoryRequest(state);
  const startedAt = Date.now();
  const previousMessages = state.chatMessages;
  // Any pending input-history snapshot becomes invalid once we start reloading transcript state.
  state.resetChatInputHistoryNavigation?.();
  state.chatLoading = true;
  state.lastError = null;
  try {
    let res: { messages?: Array<unknown>; sessionId?: string; thinkingLevel?: string };
    for (;;) {
      try {
        res = await state.client.request<{
          messages?: Array<unknown>;
          sessionId?: string;
          thinkingLevel?: string;
        }>("chat.history", {
          sessionKey,
          limit: 200,
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
    state.currentSessionId =
      typeof res.sessionId === "string" && res.sessionId.trim() ? res.sessionId : null;
    state.chatThinkingLevel = res.thinkingLevel ?? null;
    // Clear all streaming state — history includes tool results and text
    // inline, so keeping streaming artifacts would cause duplicates.
    maybeResetToolStream(state);
    state.chatStream = null;
    state.chatStreamStartedAt = null;
  } catch (err) {
    if (!shouldApplyChatHistoryResult(state, requestVersion, sessionKey)) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      state.chatMessages = [];
      state.chatThinkingLevel = null;
      state.lastError = formatMissingOperatorReadScopeMessage("existing chat history");
    } else {
      state.lastError = String(err);
    }
  } finally {
    if (isLatestChatHistoryRequest(state, requestVersion)) {
      state.chatLoading = false;
    }
  }
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
) {
  const sessionId =
    typeof state.currentSessionId === "string" && state.currentSessionId.trim()
      ? state.currentSessionId.trim()
      : undefined;
  await state.client!.request("chat.send", {
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

/**
 * Reconstruct the full assistant text the user has seen on screen by joining
 * already-committed pre-tool segments (kept in `chatStreamSegments` by
 * `handleAgentEvent` on each tool boundary) with the current post-tool
 * `chatStream`. Used by `final` / `aborted` fallback paths when the payload
 * carries no `message` and we have to persist the streamed text directly:
 * without rejoining the segments, only the post-tool tail would be persisted
 * and pre-tool text rendered above the tool card would be lost from history.
 */
function composePersistedAssistantText(state: ChatState): string {
  const segments = state.chatStreamSegments ?? [];
  const segmentText = segments.map((segment) => segment.text).join("");
  const streamText = state.chatStream ?? "";
  return segmentText + streamText;
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
  state.chatStream = "";
  state.chatStreamStartedAt = now;
  // Start a fresh run with no committed segment offset; previous runs end
  // with `final`/`aborted`/`error` resetting this, but reset again here as
  // a defensive guarantee for the first delta of the new run.
  state.chatStreamCommittedLen = 0;

  try {
    await requestChatSend(state, { message: msg, attachments, runId });
    return runId;
  } catch (err) {
    const error = formatConnectError(err);
    state.chatRunId = null;
    state.chatStream = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedLen = 0;
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
      if (finalMessage && !isAssistantSilentReply(finalMessage)) {
        state.chatMessages = [...state.chatMessages, finalMessage];
        return null;
      }
      return "final";
    }
    return null;
  }

  if (payload.state === "delta") {
    const next = extractText(payload.message);
    if (typeof next === "string" && !isSilentReplyStream(next)) {
      // The gateway broadcasts deltas as full-snapshot text including any
      // pre-tool content that was already committed to `chatStreamSegments`
      // by `handleAgentEvent` on each tool boundary. Slice off that prefix
      // so the active stream below the most recent tool card only renders
      // post-tool text (avoiding duplicate display).
      //
      // Use `>=` (not `>`) so an exact-length re-broadcast of the committed
      // prefix collapses to an empty post-tool slice instead of replaying
      // the pre-tool text under the tool card. The gateway's throttled
      // `emitChatDelta` may flush an unchanged full snapshot after the
      // throttle window, which would otherwise recreate the duplicate
      // pre-tool render below the tool card until a longer delta arrives.
      //
      // Falls back to the full text only if `next` is *shorter* than the
      // committed length (e.g. a stale delta arrived after a reset, or the
      // gateway buffer was rewound) so we never silently drop visible text.
      const committedLen = state.chatStreamCommittedLen ?? 0;
      state.chatStream =
        committedLen > 0 && next.length >= committedLen ? next.slice(committedLen) : next;
    }
  } else if (payload.state === "final") {
    const finalMessage = normalizeFinalAssistantMessage(payload.message);
    if (finalMessage && !isAssistantSilentReply(finalMessage)) {
      state.chatMessages = [...state.chatMessages, finalMessage];
    } else {
      // Fallback path: payload has no usable message, so persist the streamed
      // text. After a tool boundary `chatStream` only holds the post-tool
      // slice; rejoin any committed pre-tool segments first so the persisted
      // assistant message is not truncated to the post-tool tail.
      const persistedText = composePersistedAssistantText(state);
      if (persistedText.trim() && !isSilentReplyStream(persistedText)) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: persistedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedLen = 0;
  } else if (payload.state === "aborted") {
    const normalizedMessage = normalizeAbortedAssistantMessage(payload.message);
    if (normalizedMessage && !isAssistantSilentReply(normalizedMessage)) {
      state.chatMessages = [...state.chatMessages, normalizedMessage];
    } else {
      // Same fallback rationale as the `final` branch above: rejoin any
      // committed pre-tool segments so an aborted run doesn't lose pre-tool
      // text that was already committed to `chatStreamSegments`.
      const persistedText = composePersistedAssistantText(state);
      if (persistedText.trim() && !isSilentReplyStream(persistedText)) {
        state.chatMessages = [
          ...state.chatMessages,
          {
            role: "assistant",
            content: [{ type: "text", text: persistedText }],
            timestamp: Date.now(),
          },
        ];
      }
    }
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedLen = 0;
  } else if (payload.state === "error") {
    state.chatStream = null;
    state.chatRunId = null;
    state.chatStreamStartedAt = null;
    state.chatStreamCommittedLen = 0;
    state.lastError = payload.errorMessage ?? "chat error";
  }
  return payload.state;
}
