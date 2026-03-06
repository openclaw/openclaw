import fs from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { resolveSessionFilePath } from "../../config/sessions.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { MAX_IMAGE_BYTES } from "../../media/constants.js";
import { MEDIA_IMAGE_LINE_RE, normalizeMediaSource } from "../../media/parse.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  stripInlineDirectiveTagsForDisplay,
  stripInlineDirectiveTagsFromMessageForDisplay,
} from "../../utils/directive-tags.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isWebchatClient,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  type ChatAbortControllerEntry,
  type ChatAbortOps,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import { stripEnvelopeFromMessage, stripEnvelopeFromMessages } from "../chat-sanitize.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  hasGatewayClientCap,
} from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../protocol/schema/primitives.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { setGatewayDedupeEntry } from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

type TranscriptAppendResult = {
  ok: boolean;
  messageId?: string;
  message?: Record<string, unknown>;
  error?: string;
};

type AbortOrigin = "rpc" | "stop-command";

type AbortedPartialSnapshot = {
  runId: string;
  sessionId: string;
  text: string;
  abortOrigin: AbortOrigin;
};

const CHAT_HISTORY_TEXT_MAX_CHARS = 12_000;
const CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;
const CHAT_HISTORY_OVERSIZED_PLACEHOLDER = "[chat.history omitted: message too large]";
let chatHistoryPlaceholderEmitCount = 0;
const CHANNEL_AGNOSTIC_SESSION_SCOPES = new Set([
  "main",
  "direct",
  "dm",
  "group",
  "channel",
  "cron",
  "run",
  "subagent",
  "acp",
  "thread",
  "topic",
]);
const CHANNEL_SCOPED_SESSION_SHAPES = new Set(["direct", "dm", "group", "channel"]);

type ChatSendDeliveryEntry = {
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
};

type ChatSendOriginatingRoute = {
  originatingChannel: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  explicitDeliverRoute: boolean;
};

function resolveChatSendOriginatingRoute(params: {
  client?: { mode?: string | null; id?: string | null } | null;
  deliver?: boolean;
  entry?: ChatSendDeliveryEntry;
  hasConnectedClient?: boolean;
  mainKey?: string;
  sessionKey: string;
}): ChatSendOriginatingRoute {
  const shouldDeliverExternally = params.deliver === true;
  if (!shouldDeliverExternally) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const routeChannelCandidate = normalizeMessageChannel(
    params.entry?.deliveryContext?.channel ?? params.entry?.lastChannel,
  );
  const routeToCandidate = params.entry?.deliveryContext?.to ?? params.entry?.lastTo;
  const routeAccountIdCandidate =
    params.entry?.deliveryContext?.accountId ?? params.entry?.lastAccountId ?? undefined;
  const routeThreadIdCandidate =
    params.entry?.deliveryContext?.threadId ?? params.entry?.lastThreadId;
  if (params.sessionKey.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  const parsedSessionKey = parseAgentSessionKey(params.sessionKey);
  const sessionScopeParts = (parsedSessionKey?.rest ?? params.sessionKey)
    .split(":", 3)
    .filter(Boolean);
  const sessionScopeHead = sessionScopeParts[0];
  const sessionChannelHint = normalizeMessageChannel(sessionScopeHead);
  const normalizedSessionScopeHead = (sessionScopeHead ?? "").trim().toLowerCase();
  const sessionPeerShapeCandidates = [sessionScopeParts[1], sessionScopeParts[2]]
    .map((part) => (part ?? "").trim().toLowerCase())
    .filter(Boolean);
  const isChannelAgnosticSessionScope = CHANNEL_AGNOSTIC_SESSION_SCOPES.has(
    normalizedSessionScopeHead,
  );
  const isChannelScopedSession = sessionPeerShapeCandidates.some((part) =>
    CHANNEL_SCOPED_SESSION_SHAPES.has(part),
  );
  const hasLegacyChannelPeerShape =
    !isChannelScopedSession &&
    typeof sessionScopeParts[1] === "string" &&
    sessionChannelHint === routeChannelCandidate;
  const isFromWebchatClient =
    isWebchatClient(params.client) || params.client?.mode === GATEWAY_CLIENT_MODES.UI;
  const configuredMainKey = (params.mainKey ?? "main").trim().toLowerCase();
  const isConfiguredMainSessionScope =
    normalizedSessionScopeHead.length > 0 && normalizedSessionScopeHead === configuredMainKey;

  // Keep explicit delivery for channel-scoped sessions, but refuse to inherit
  // stale external routes for shared-main and other channel-agnostic webchat/UI
  // turns where the session key does not encode the user's current target.
  // Preserve the old configured-main contract: any connected non-webchat client
  // may inherit the last external route even when client metadata is absent.
  const canInheritDeliverableRoute = Boolean(
    sessionChannelHint &&
    sessionChannelHint !== INTERNAL_MESSAGE_CHANNEL &&
    ((!isChannelAgnosticSessionScope && (isChannelScopedSession || hasLegacyChannelPeerShape)) ||
      (isConfiguredMainSessionScope && params.hasConnectedClient && !isFromWebchatClient)),
  );
  const hasDeliverableRoute =
    canInheritDeliverableRoute &&
    routeChannelCandidate &&
    routeChannelCandidate !== INTERNAL_MESSAGE_CHANNEL &&
    typeof routeToCandidate === "string" &&
    routeToCandidate.trim().length > 0;

  if (!hasDeliverableRoute) {
    return {
      originatingChannel: INTERNAL_MESSAGE_CHANNEL,
      explicitDeliverRoute: false,
    };
  }

  return {
    originatingChannel: routeChannelCandidate,
    originatingTo: routeToCandidate,
    accountId: routeAccountIdCandidate,
    messageThreadId: routeThreadIdCandidate,
    explicitDeliverRoute: true,
  };
}

function stripDisallowedChatControlChars(message: string): string {
  let output = "";
  for (const char of message) {
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      output += char;
    }
  }
  return output;
}

export function sanitizeChatSendMessageInput(
  message: string,
): { ok: true; message: string } | { ok: false; error: string } {
  const normalized = message.normalize("NFC");
  if (normalized.includes("\u0000")) {
    return { ok: false, error: "message must not contain null bytes" };
  }
  return { ok: true, message: stripDisallowedChatControlChars(normalized) };
}

function truncateChatHistoryText(text: string): { text: string; truncated: boolean } {
  if (text.length <= CHAT_HISTORY_TEXT_MAX_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, CHAT_HISTORY_TEXT_MAX_CHARS)}\n...(truncated)...`,
    truncated: true,
  };
}

function sanitizeChatHistoryContentBlock(block: unknown): { block: unknown; changed: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = false;
  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }
  if (typeof entry.partialJson === "string") {
    const res = truncateChatHistoryText(entry.partialJson);
    entry.partialJson = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.arguments === "string") {
    const res = truncateChatHistoryText(entry.arguments);
    entry.arguments = res.text;
    changed ||= res.truncated;
  }
  if (typeof entry.thinking === "string") {
    const res = truncateChatHistoryText(entry.thinking);
    entry.thinking = res.text;
    changed ||= res.truncated;
  }
  if ("thinkingSignature" in entry) {
    delete entry.thinkingSignature;
    changed = true;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type === "image" && typeof entry.data === "string") {
    const bytes = Buffer.byteLength(entry.data, "utf8");
    delete entry.data;
    entry.omitted = true;
    entry.bytes = bytes;
    changed = true;
  }
  // Recurse into nested content[] arrays (e.g. tool_result blocks) so that
  // extractImages (browser-side, which also recurses) doesn't find unsanitized
  // base64 image blocks at nested depth — preventing duplicates on reload.
  if (Array.isArray(entry.content)) {
    const updated = entry.content.map((nested: unknown) => sanitizeChatHistoryContentBlock(nested));
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
  }
  return { block: changed ? entry : block, changed };
}

function sanitizeChatHistoryMessage(message: unknown): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;

  if ("details" in entry) {
    delete entry.details;
    changed = true;
  }
  if ("usage" in entry) {
    delete entry.usage;
    changed = true;
  }
  if ("cost" in entry) {
    delete entry.cost;
    changed = true;
  }

  if (typeof entry.content === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.content);
    const res = truncateChatHistoryText(stripped.text);
    entry.content = res.text;
    changed ||= stripped.changed || res.truncated;
  } else if (Array.isArray(entry.content)) {
    const updated = entry.content.map((block) => sanitizeChatHistoryContentBlock(block));
    if (updated.some((item) => item.changed)) {
      entry.content = updated.map((item) => item.block);
      changed = true;
    }
  }

  if (typeof entry.text === "string") {
    const stripped = stripInlineDirectiveTagsForDisplay(entry.text);
    const res = truncateChatHistoryText(stripped.text);
    entry.text = res.text;
    changed ||= stripped.changed || res.truncated;
  }

  return { message: changed ? entry : message, changed };
}

/**
 * Extract the visible text from an assistant history message for silent-token checks.
 * Returns `undefined` for non-assistant messages or messages with no extractable text.
 * When `entry.text` is present it takes precedence over `entry.content` to avoid
 * dropping messages that carry real text alongside a stale `content: "NO_REPLY"`.
 */
function extractAssistantTextForSilentCheck(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const entry = message as Record<string, unknown>;
  if (entry.role !== "assistant") {
    return undefined;
  }
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  if (!Array.isArray(entry.content) || entry.content.length === 0) {
    return undefined;
  }

  const texts: string[] = [];
  for (const block of entry.content) {
    if (!block || typeof block !== "object") {
      return undefined;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text" || typeof typed.text !== "string") {
      return undefined;
    }
    texts.push(typed.text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function sanitizeChatHistoryMessages(messages: unknown[]): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const message of messages) {
    const res = sanitizeChatHistoryMessage(message);
    changed ||= res.changed;
    // Drop assistant messages whose entire visible text is the silent reply token.
    const text = extractAssistantTextForSilentCheck(res.message);
    if (text !== undefined && isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function buildOversizedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const role =
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : "assistant";
  const timestamp =
    message &&
    typeof message === "object" &&
    typeof (message as { timestamp?: unknown }).timestamp === "number"
      ? (message as { timestamp: number }).timestamp
      : Date.now();
  return {
    role,
    timestamp,
    content: [{ type: "text", text: CHAT_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: { truncated: true, reason: "oversized" },
  };
}

function messageHasImageData(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "image" && typeof b.data === "string") {
      return true;
    }
  }
  return false;
}

function replaceOversizedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  const { messages, maxSingleMessageBytes } = params;
  if (messages.length === 0) {
    return { messages, replacedCount: 0 };
  }
  // Allow much higher cap for messages carrying inline base64 images.
  // A single 800×800 JPEG is ~100-200KB raw, ~130-270KB as base64.
  // Three images can easily exceed 512KB, so we allow up to 2MB.
  const imageMessageCap = Math.max(maxSingleMessageBytes * 16, 2 * 1024 * 1024);
  let replacedCount = 0;
  const next = messages.map((message) => {
    const cap = messageHasImageData(message) ? imageMessageCap : maxSingleMessageBytes;
    if (jsonUtf8Bytes(message) <= cap) {
      return message;
    }
    replacedCount += 1;
    return buildOversizedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? next : messages, replacedCount };
}

function enforceChatHistoryFinalBudget(params: { messages: unknown[]; maxBytes: number }): {
  messages: unknown[];
  placeholderCount: number;
} {
  const { messages, maxBytes } = params;
  if (messages.length === 0) {
    return { messages, placeholderCount: 0 };
  }
  if (jsonUtf8Bytes(messages) <= maxBytes) {
    return { messages, placeholderCount: 0 };
  }
  const last = messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= maxBytes) {
    return { messages: [last], placeholderCount: 0 };
  }
  const placeholder = buildOversizedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= maxBytes) {
    return { messages: [placeholder], placeholderCount: 1 };
  }
  return { messages: [], placeholderCount: 0 };
}

// ---------------------------------------------------------------------------
// MEDIA: image injection for chat.history
// ---------------------------------------------------------------------------
// The image tool emits MEDIA:<container-path> text blocks in tool results.
// The TUI renders these by reading the file directly (readFileSync on the
// container path).  The web chat has no filesystem access AND hides tool
// result messages when the "show thinking" toggle is off.  To ensure images
// are always visible, we resolve the paths server-side and inject the base64
// data into the NEXT assistant message (which always renders regardless of
// the thinking toggle).
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function extractMediaImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(MEDIA_IMAGE_LINE_RE);
    if (match?.[1]) {
      // Normalize file:// URIs to bare paths (mirrors TUI's getMediaPaths).
      const raw = normalizeMediaSource(match[1].trim());
      if (raw && path.isAbsolute(raw) && !raw.includes("\0")) {
        paths.push(raw);
      }
    }
  }
  return paths;
}

/** Maximum number of images that can accumulate across tool results before injection. */
const MAX_PENDING_IMAGES = 20;

async function readImageAsBase64(
  filePath: string,
): Promise<{ data: string; media_type: string } | null> {
  try {
    // Reject paths containing ".." components to prevent directory traversal.
    // Check BEFORE normalization — normalize() resolves ".." in absolute paths,
    // so a post-normalize check would always pass (e.g. /workspace/../etc/shadow → /etc/shadow).
    if (filePath.includes("..")) {
      return null;
    }
    const normalized = path.normalize(filePath);
    const ext = path.extname(normalized).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      return null;
    }
    // Use lstat (no symlink follow) to reject symlinks before reading.
    const stat = await lstat(normalized);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return null;
    }
    if (stat.size > MAX_IMAGE_BYTES || stat.size === 0) {
      return null;
    }
    const buf = await readFile(normalized);
    // Re-check size after read to close the TOCTOU window: the file could
    // have been replaced between lstat and readFile.
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      return null;
    }
    return { data: buf.toString("base64"), media_type: mime };
  } catch {
    return null;
  }
}

/**
 * Collect MEDIA: image paths from tool_result content blocks.
 */
async function collectMediaImagesFromBlock(
  block: Record<string, unknown>,
  seen: Set<string>,
): Promise<
  Array<{
    type: string;
    data: string;
    media_type: string;
  }>
> {
  const bType = typeof block.type === "string" ? block.type : "";
  if (bType !== "tool_result" && bType !== "toolresult") {
    return [];
  }

  const texts: string[] = [];
  if (typeof block.content === "string") {
    texts.push(block.content);
  } else if (Array.isArray(block.content)) {
    for (const nested of block.content as unknown[]) {
      if (
        nested &&
        typeof nested === "object" &&
        (nested as Record<string, unknown>).type === "text" &&
        typeof (nested as Record<string, unknown>).text === "string"
      ) {
        texts.push((nested as Record<string, unknown>).text as string);
      }
    }
  }

  const images: Array<{ type: string; data: string; media_type: string }> = [];
  for (const text of texts) {
    for (const filePath of extractMediaImagePaths(text)) {
      if (seen.has(filePath)) {
        continue;
      }
      const img = await readImageAsBase64(filePath);
      if (img) {
        images.push({ type: "image", ...img });
        seen.add(filePath);
      }
    }
  }
  return images;
}

/**
 * Collect MEDIA: image paths from plain text blocks (e.g. inside messages with
 * role "toolResult" where content is [{type: "text", text: "MEDIA:..."}]).
 */
async function collectMediaImagesFromTextBlock(
  block: Record<string, unknown>,
  seen: Set<string>,
): Promise<
  Array<{
    type: string;
    data: string;
    media_type: string;
  }>
> {
  if (typeof block.type !== "string" || block.type !== "text" || typeof block.text !== "string") {
    return [];
  }
  const images: Array<{ type: string; data: string; media_type: string }> = [];
  for (const filePath of extractMediaImagePaths(block.text)) {
    if (seen.has(filePath)) {
      continue;
    }
    const img = await readImageAsBase64(filePath);
    if (img) {
      images.push({ type: "image", ...img });
      seen.add(filePath);
    }
  }
  return images;
}

/** Regex to extract absolute image paths from a shell command string. */
const IMAGE_PATH_IN_COMMAND_RE =
  /(?:^|\s)(\/[^\s'"`;|&>]+\.(?:png|jpe?g|gif|webp))(?![^\s'"`;|&>])/gi;

/** Known image-viewer command patterns (view-image skill, common CLIs). */
const IMAGE_VIEWER_CMD_RE =
  /\b(?:view[-_]?image|imgcat|icat|viu|timg|catimg|chafa|kitty\s+icat)\b/i;

const TOOL_USE_TYPES = new Set(["toolcall", "tool_call", "tooluse", "tool_use"]);

/**
 * Extract image file paths from exec tool_use blocks whose command looks
 * like an image-viewer invocation (e.g. `sh /app/view-image.sh /path.jpg`).
 * Only paths that actually exist on disk are returned.
 */
async function collectImagePathsFromToolUse(
  block: Record<string, unknown>,
  seen: Set<string>,
): Promise<Array<{ type: string; data: string; media_type: string }>> {
  const kind = (typeof block.type === "string" ? block.type : "").toLowerCase();
  if (!TOOL_USE_TYPES.has(kind) && !(typeof block.name === "string" && block.arguments != null)) {
    return [];
  }

  const name = (typeof block.name === "string" ? block.name : "").toLowerCase();
  if (name !== "exec") {
    return [];
  }

  // Extract the command string from arguments/input.
  const args = block.arguments ?? block.input ?? block.args;
  let command = "";
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      command = typeof parsed?.command === "string" ? parsed.command : "";
    } catch {
      command = args;
    }
  } else if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") {
      command = a.command;
    }
  }
  if (!command) {
    return [];
  }

  // Only proceed for commands that look like image viewers.
  if (!IMAGE_VIEWER_CMD_RE.test(command)) {
    return [];
  }

  // Collect all regex matches synchronously before any await — IMAGE_PATH_IN_COMMAND_RE
  // is a module-level /g regex whose lastIndex would be corrupted by concurrent calls
  // if an await suspended mid-loop.
  const matchedPaths: string[] = [];
  IMAGE_PATH_IN_COMMAND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_PATH_IN_COMMAND_RE.exec(command)) !== null) {
    if (match[1]) {
      matchedPaths.push(match[1]);
    }
  }

  const images: Array<{ type: string; data: string; media_type: string }> = [];
  for (const p of matchedPaths) {
    if (!p || !path.isAbsolute(p) || p.includes("\0") || seen.has(p)) {
      continue;
    }
    const img = await readImageAsBase64(p);
    if (img) {
      images.push({ type: "image", ...img });
      seen.add(p);
    }
  }
  return images;
}

/**
 * Scan messages for images referenced by tool results or tool calls, read them
 * from the container filesystem, and inject base64 image blocks into the next
 * assistant text message so the web chat always displays them (even when the
 * "show thinking" toggle hides tool result messages).
 *
 * Two collection strategies run in parallel:
 *  1. MEDIA: text lines in tool_result content  (from the dedicated image tool)
 *  2. Image paths in exec tool_use commands     (from the view-image skill)
 */
async function injectMediaImagesIntoHistory(messages: unknown[]): Promise<unknown[]> {
  if (messages.length === 0) {
    return messages;
  }

  // Shallow-clone each message object so we can mutate content arrays safely.
  const result: unknown[] = messages.map((m) =>
    m && typeof m === "object" ? { ...(m as Record<string, unknown>) } : m,
  );

  // Total byte budget for injected image data.  The history cap is 6MB; keep
  // injected images well under half of that so the rest of the conversation
  // (text, tool cards, etc.) still fits.
  const MAX_TOTAL_INJECTED_BYTES = 2 * 1024 * 1024; // 2MB
  let totalInjectedBytes = 0;

  let pendingImages: Array<{ type: string; data: string; media_type: string }> = [];
  let pendingBytes = 0;
  const seenPaths = new Set<string>();

  for (let i = 0; i < result.length; i++) {
    const msg = result[i];
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const entry = msg as Record<string, unknown>;
    const content = entry.content;
    if (!Array.isArray(content)) {
      continue;
    }

    // Detect toolResult-role messages to enable text block MEDIA: scanning.
    const msgRole = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
    const isToolResultMsg =
      msgRole === "toolresult" || msgRole === "tool_result" || msgRole === "tool";

    // When the budget is exhausted, skip collecting NEW images but still allow
    // injection of already-pending images into assistant messages (otherwise
    // pending images only flush at the very end of history, possibly attaching
    // to an unrelated later message).
    const budgetExhausted = totalInjectedBytes + pendingBytes >= MAX_TOTAL_INJECTED_BYTES;
    if (budgetExhausted && pendingImages.length === 0) {
      continue;
    }

    // Only collect new images when budget allows — but always fall through to
    // the injection branch below so pending images attach to the right message.
    if (!budgetExhausted) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;

        // Strategy 1a: Collect images from MEDIA: lines in tool_result content blocks.
        if (pendingImages.length < MAX_PENDING_IMAGES) {
          const mediaImages = await collectMediaImagesFromBlock(b, seenPaths);
          for (const img of mediaImages) {
            if (pendingImages.length >= MAX_PENDING_IMAGES) {
              break;
            }
            pendingImages.push(img);
            pendingBytes += img.data.length;
          }
        }

        // Strategy 1b: Collect images from plain text blocks in toolResult messages.
        // Handles the format: {role:"toolResult", content:[{type:"text", text:"MEDIA:..."}]}
        if (pendingImages.length < MAX_PENDING_IMAGES && isToolResultMsg) {
          const textImages = await collectMediaImagesFromTextBlock(b, seenPaths);
          for (const img of textImages) {
            if (pendingImages.length >= MAX_PENDING_IMAGES) {
              break;
            }
            pendingImages.push(img);
            pendingBytes += img.data.length;
          }
        }

        // Strategy 2: Collect images from exec commands with image-viewer patterns.
        if (pendingImages.length < MAX_PENDING_IMAGES) {
          const execImages = await collectImagePathsFromToolUse(b, seenPaths);
          for (const img of execImages) {
            if (pendingImages.length >= MAX_PENDING_IMAGES) {
              break;
            }
            pendingImages.push(img);
            pendingBytes += img.data.length;
          }
        }
      }
    }

    // Inject accumulated images into the next text-only assistant message.
    if (pendingImages.length > 0 && typeof entry.role === "string" && entry.role === "assistant") {
      const hasText = content.some(
        (b: unknown) =>
          b &&
          typeof b === "object" &&
          (b as Record<string, unknown>).type === "text" &&
          typeof (b as Record<string, unknown>).text === "string" &&
          ((b as Record<string, unknown>).text as string).trim().length > 0,
      );
      const hasToolUse = content.some((b: unknown) => {
        if (!b || typeof b !== "object") {
          return false;
        }
        const k = (
          typeof (b as Record<string, unknown>).type === "string"
            ? ((b as Record<string, unknown>).type as string)
            : ""
        ).toLowerCase();
        return TOOL_USE_TYPES.has(k);
      });
      if (hasText && !hasToolUse) {
        // Deduplicate by full base64 content before budget trimming — catches
        // the same image loaded via different strategies (e.g. MEDIA: path vs
        // exec tool_use) where the resolved path string differs but the
        // underlying file content is identical.  Uses full string as key
        // (Set stores a reference, not a copy) to avoid prefix collisions
        // across images with identical headers/dimensions.
        const seen64 = new Set<string>();
        const deduped: typeof pendingImages = [];
        for (const img of pendingImages) {
          if (!seen64.has(img.data)) {
            seen64.add(img.data);
            deduped.push(img);
          }
        }
        // Trim pending images to fit within the remaining byte budget.
        const affordable: typeof pendingImages = [];
        for (const img of deduped) {
          const imgBytes = img.data.length; // base64 string length ≈ byte count
          if (totalInjectedBytes + imgBytes > MAX_TOTAL_INJECTED_BYTES) {
            continue;
          }
          affordable.push(img);
          totalInjectedBytes += imgBytes;
        }
        if (affordable.length > 0) {
          entry.content = [...content, ...affordable];
        }
        pendingImages = [];
        pendingBytes = 0;
        // Reset seenPaths so subsequent conversation rounds can re-process
        // the same image paths (dedup only applies within a single round).
        seenPaths.clear();
      } else if (hasToolUse) {
        // The assistant turn has pending tool calls — images carry forward to
        // the next qualifying assistant message.  Preserve seenPaths so that
        // multi-step agent commands (e.g. find → view-image) that produce the
        // same MEDIA: path across consecutive tool_result blocks don't inject
        // the same image twice.
      }
    }
  }

  // Flush any remaining pending images into the last assistant message in the
  // history.  Without this, images produced near the end of a conversation
  // (e.g. the final tool result with no subsequent text-only assistant turn)
  // would be silently lost.
  if (pendingImages.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i];
      if (!msg || typeof msg !== "object") {
        continue;
      }
      const entry = msg as Record<string, unknown>;
      if (
        typeof entry.role !== "string" ||
        entry.role !== "assistant" ||
        !Array.isArray(entry.content)
      ) {
        continue;
      }
      // Deduplicate by base64 content (mirrors main injection path).
      const seen64 = new Set<string>();
      const deduped: typeof pendingImages = [];
      for (const img of pendingImages) {
        if (!seen64.has(img.data)) {
          seen64.add(img.data);
          deduped.push(img);
        }
      }
      const affordable: typeof pendingImages = [];
      for (const img of deduped) {
        const imgBytes = img.data.length;
        if (totalInjectedBytes + imgBytes > MAX_TOTAL_INJECTED_BYTES) {
          continue;
        }
        affordable.push(img);
        totalInjectedBytes += imgBytes;
      }
      if (affordable.length > 0) {
        entry.content = [...(entry.content as unknown[]), ...affordable];
      }
      break;
    }
  }

  return result;
}

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | null {
  const { sessionId, storePath, sessionFile, agentId } = params;
  if (!storePath && !sessionFile) {
    return null;
  }
  try {
    const sessionsDir = storePath ? path.dirname(storePath) : undefined;
    return resolveSessionFilePath(
      sessionId,
      sessionFile ? { sessionFile } : undefined,
      sessionsDir || agentId ? { sessionsDir, agentId } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function transcriptHasIdempotencyKey(transcriptPath: string, idempotencyKey: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as { message?: { idempotencyKey?: unknown } };
      if (parsed?.message?.idempotencyKey === idempotencyKey) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function appendAssistantTranscriptMessage(params: {
  message: string;
  label?: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
  createIfMissing?: boolean;
  idempotencyKey?: string;
  abortMeta?: {
    aborted: true;
    origin: AbortOrigin;
    runId: string;
  };
}): TranscriptAppendResult {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!transcriptPath) {
    return { ok: false, error: "transcript path not resolved" };
  }

  if (!fs.existsSync(transcriptPath)) {
    if (!params.createIfMissing) {
      return { ok: false, error: "transcript file not found" };
    }
    const ensured = ensureTranscriptFile({
      transcriptPath,
      sessionId: params.sessionId,
    });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error ?? "failed to create transcript file" };
    }
  }

  if (params.idempotencyKey && transcriptHasIdempotencyKey(transcriptPath, params.idempotencyKey)) {
    return { ok: true };
  }

  return appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    message: params.message,
    label: params.label,
    idempotencyKey: params.idempotencyKey,
    abortMeta: params.abortMeta,
  });
}

function collectSessionAbortPartials(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  sessionKey: string;
  abortOrigin: AbortOrigin;
}): AbortedPartialSnapshot[] {
  const out: AbortedPartialSnapshot[] = [];
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.sessionKey !== params.sessionKey) {
      continue;
    }
    const text = params.chatRunBuffers.get(runId);
    if (!text || !text.trim()) {
      continue;
    }
    out.push({
      runId,
      sessionId: active.sessionId,
      text,
      abortOrigin: params.abortOrigin,
    });
  }
  return out;
}

function persistAbortedPartials(params: {
  context: Pick<GatewayRequestContext, "logGateway">;
  sessionKey: string;
  snapshots: AbortedPartialSnapshot[];
}) {
  if (params.snapshots.length === 0) {
    return;
  }
  const { storePath, entry } = loadSessionEntry(params.sessionKey);
  for (const snapshot of params.snapshots) {
    const sessionId = entry?.sessionId ?? snapshot.sessionId ?? snapshot.runId;
    const appended = appendAssistantTranscriptMessage({
      message: snapshot.text,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      createIfMissing: true,
      idempotencyKey: `${snapshot.runId}:assistant`,
      abortMeta: {
        aborted: true,
        origin: snapshot.abortOrigin,
        runId: snapshot.runId,
      },
    });
    if (!appended.ok) {
      params.context.logGateway.warn(
        `chat.abort transcript append failed: ${appended.error ?? "unknown error"}`,
      );
    }
  }
}

function createChatAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunBuffers: context.chatRunBuffers,
    chatDeltaSentAt: context.chatDeltaSentAt,
    chatAbortedRuns: context.chatAbortedRuns,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

function abortChatRunsForSessionKeyWithPartials(params: {
  context: GatewayRequestContext;
  ops: ChatAbortOps;
  sessionKey: string;
  abortOrigin: AbortOrigin;
  stopReason?: string;
}) {
  const snapshots = collectSessionAbortPartials({
    chatAbortControllers: params.context.chatAbortControllers,
    chatRunBuffers: params.context.chatRunBuffers,
    sessionKey: params.sessionKey,
    abortOrigin: params.abortOrigin,
  });
  const res = abortChatRunsForSessionKey(params.ops, {
    sessionKey: params.sessionKey,
    stopReason: params.stopReason,
  });
  if (res.aborted) {
    persistAbortedPartials({
      context: params.context,
      sessionKey: params.sessionKey,
      snapshots,
    });
  }
  return res;
}

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string) {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

function broadcastChatFinal(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  message?: Record<string, unknown>;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const strippedEnvelopeMessage = stripEnvelopeFromMessage(params.message) as
    | Record<string, unknown>
    | undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "final" as const,
    message: stripInlineDirectiveTagsFromMessageForDisplay(strippedEnvelopeMessage),
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

function broadcastChatError(params: {
  context: Pick<GatewayRequestContext, "broadcast" | "nodeSendToSession" | "agentRunSeq">;
  runId: string;
  sessionKey: string;
  errorMessage?: string;
}) {
  const seq = nextChatSeq({ agentRunSeq: params.context.agentRunSeq }, params.runId);
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload);
  params.context.nodeSendToSession(params.sessionKey, "chat", payload);
  params.context.agentRunSeq.delete(params.runId);
}

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const normalized = sanitizeChatHistoryMessages(sanitized);
    // Resolve MEDIA:<path> references in tool results to inline base64 images
    // so the web chat can display them (the browser has no container filesystem access).
    const withImages = await injectMediaImagesIntoHistory(normalized);
    const maxHistoryBytes = getMaxChatHistoryMessagesBytes();
    const perMessageHardCap = Math.min(CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
    const replaced = replaceOversizedChatHistoryMessages({
      messages: withImages,
      maxSingleMessageBytes: perMessageHardCap,
    });
    const capped = capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
    const bounded = enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
    const placeholderCount = replaced.replacedCount + bounded.placeholderCount;
    if (placeholderCount > 0) {
      chatHistoryPlaceholderEmitCount += placeholderCount;
      context.logGateway.debug(
        `chat.history omitted oversized payloads placeholders=${placeholderCount} total=${chatHistoryPlaceholderEmitCount}`,
      );
    }
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
      const { provider, model } = resolveSessionModelRef(cfg, entry, sessionAgentId);
      const catalog = await context.loadGatewayModelCatalog();
      thinkingLevel = resolveThinkingDefault({
        cfg,
        provider,
        model,
        catalog,
      });
    }
    const verboseLevel = entry?.verboseLevel ?? cfg.agents?.defaults?.verboseDefault;
    respond(true, {
      sessionKey,
      sessionId,
      messages: bounded.messages,
      thinkingLevel,
      verboseLevel,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey: rawSessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = createChatAbortOps(context);

    if (!runId) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops,
        sessionKey: rawSessionKey,
        abortOrigin: "rpc",
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== rawSessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const partialText = context.chatRunBuffers.get(runId);
    const res = abortChatRunById(ops, {
      runId,
      sessionKey: rawSessionKey,
      stopReason: "rpc",
    });
    if (res.aborted && partialText && partialText.trim()) {
      persistAbortedPartials({
        context,
        sessionKey: rawSessionKey,
        snapshots: [
          {
            runId,
            sessionId: active.sessionId,
            text: partialText,
            abortOrigin: "rpc",
          },
        ],
      });
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context, client }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      timeoutMs?: number;
      idempotencyKey: string;
    };
    const sanitizedMessageResult = sanitizeChatSendMessageInput(p.message);
    if (!sanitizedMessageResult.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, sanitizedMessageResult.error),
      );
      return;
    }
    const inboundMessage = sanitizedMessageResult.message;
    const stopCommand = isChatStopCommandText(inboundMessage);
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(p.attachments);
    const rawMessage = inboundMessage.trim();
    if (!rawMessage && normalizedAttachments.length === 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "message or attachment required"),
      );
      return;
    }
    let parsedMessage = inboundMessage;
    let parsedImages: ChatImageContent[] = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const rawSessionKey = p.sessionKey;
    const { cfg, entry, canonicalKey: sessionKey } = loadSessionEntry(rawSessionKey);
    const timeoutMs = resolveAgentTimeoutMs({
      cfg,
      overrideMs: p.timeoutMs,
    });
    const now = Date.now();
    const clientRunId = p.idempotencyKey;

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKeyWithPartials({
        context,
        ops: createChatAbortOps(context),
        sessionKey: rawSessionKey,
        abortOrigin: "stop-command",
        stopReason: "stop",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId: entry?.sessionId ?? clientRunId,
        sessionKey: rawSessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      });
      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      const trimmedMessage = parsedMessage.trim();
      const injectThinking = Boolean(
        p.thinking && trimmedMessage && !trimmedMessage.startsWith("/"),
      );
      const commandBody = injectThinking ? `/think ${p.thinking} ${parsedMessage}` : parsedMessage;
      const clientInfo = client?.connect?.client;
      const {
        originatingChannel,
        originatingTo,
        accountId,
        messageThreadId,
        explicitDeliverRoute,
      } = resolveChatSendOriginatingRoute({
        client: clientInfo,
        deliver: p.deliver,
        entry,
        hasConnectedClient: client?.connect !== undefined,
        mainKey: cfg.session?.mainKey,
        sessionKey,
      });
      // Inject timestamp so agents know the current date/time.
      // Only BodyForAgent gets the timestamp — Body stays raw for UI display.
      // See: https://github.com/moltbot/moltbot/issues/3658
      const stampedMessage = injectTimestamp(parsedMessage, timestampOptsFromConfig(cfg));

      const ctx: MsgContext = {
        Body: parsedMessage,
        BodyForAgent: stampedMessage,
        BodyForCommands: commandBody,
        RawBody: parsedMessage,
        CommandBody: commandBody,
        SessionKey: sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: originatingChannel,
        OriginatingTo: originatingTo,
        ExplicitDeliverRoute: explicitDeliverRoute,
        AccountId: accountId,
        MessageThreadId: messageThreadId,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: clientRunId,
        SenderId: clientInfo?.id,
        SenderName: clientInfo?.displayName,
        SenderUsername: clientInfo?.displayName,
        GatewayClientScopes: client?.connect?.scopes,
      };

      const agentId = resolveSessionAgentId({
        sessionKey,
        config: cfg,
      });
      const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
        cfg,
        agentId,
        channel: INTERNAL_MESSAGE_CHANNEL,
      });
      const finalReplyParts: string[] = [];
      const dispatcher = createReplyDispatcher({
        ...prefixOptions,
        onError: (err) => {
          context.logGateway.warn(`webchat dispatch failed: ${formatForLog(err)}`);
        },
        deliver: async (payload, info) => {
          if (info.kind !== "final") {
            return;
          }
          const text = payload.text?.trim() ?? "";
          if (!text) {
            return;
          }
          finalReplyParts.push(text);
        },
      });

      let agentRunStarted = false;
      void dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          onAgentRunStart: (runId) => {
            agentRunStarted = true;
            const connId = typeof client?.connId === "string" ? client.connId : undefined;
            const wantsToolEvents = hasGatewayClientCap(
              client?.connect?.caps,
              GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
            );
            if (connId && wantsToolEvents) {
              context.registerToolEventRecipient(runId, connId);
              // Register for any other active runs *in the same session* so
              // late-joining clients (e.g. page refresh mid-response) receive
              // in-progress tool events without leaking cross-session data.
              for (const [activeRunId, active] of context.chatAbortControllers) {
                if (activeRunId !== runId && active.sessionKey === p.sessionKey) {
                  context.registerToolEventRecipient(activeRunId, connId);
                }
              }
            }
          },
          onModelSelected,
        },
      })
        .then(() => {
          if (!agentRunStarted) {
            const combinedReply = finalReplyParts
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n")
              .trim();
            let message: Record<string, unknown> | undefined;
            if (combinedReply) {
              const { storePath: latestStorePath, entry: latestEntry } =
                loadSessionEntry(sessionKey);
              const sessionId = latestEntry?.sessionId ?? entry?.sessionId ?? clientRunId;
              const appended = appendAssistantTranscriptMessage({
                message: combinedReply,
                sessionId,
                storePath: latestStorePath,
                sessionFile: latestEntry?.sessionFile,
                agentId,
                createIfMissing: true,
              });
              if (appended.ok) {
                message = appended.message;
              } else {
                context.logGateway.warn(
                  `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
                );
                const now = Date.now();
                message = {
                  role: "assistant",
                  content: [{ type: "text", text: combinedReply }],
                  timestamp: now,
                  // Keep this compatible with Pi stopReason enums even though this message isn't
                  // persisted to the transcript due to the append failure.
                  stopReason: "stop",
                  usage: { input: 0, output: 0, totalTokens: 0 },
                };
              }
            }
            broadcastChatFinal({
              context,
              runId: clientRunId,
              sessionKey: rawSessionKey,
              message,
            });
          }
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            },
          });
          broadcastChatError({
            context,
            runId: clientRunId,
            sessionKey: rawSessionKey,
            errorMessage: String(err),
          });
        })
        .finally(() => {
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${clientRunId}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const rawSessionKey = p.sessionKey;
    const { cfg, storePath, entry } = loadSessionEntry(rawSessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    const appended = appendAssistantTranscriptMessage({
      message: p.message,
      label: p.label,
      sessionId,
      storePath,
      sessionFile: entry?.sessionFile,
      agentId: resolveSessionAgentId({ sessionKey: rawSessionKey, config: cfg }),
      createIfMissing: false,
    });
    if (!appended.ok || !appended.messageId || !appended.message) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to write transcript: ${appended.error ?? "unknown error"}`,
        ),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${appended.messageId}`,
      sessionKey: rawSessionKey,
      seq: 0,
      state: "final" as const,
      message: stripInlineDirectiveTagsFromMessageForDisplay(
        stripEnvelopeFromMessage(appended.message) as Record<string, unknown>,
      ),
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(rawSessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId: appended.messageId });
  },
};

/** @internal — exposed for unit tests only. */
export const __test = {
  extractMediaImagePaths,
  readImageAsBase64,
  injectMediaImagesIntoHistory,
};
