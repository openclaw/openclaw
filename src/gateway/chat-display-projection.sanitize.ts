import { estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { parseInboundMediaUri, buildInboundMediaUriFromPath } from "../media/media-reference.js";
import { STATE_CONTENTION_DIAGNOSTIC } from "../sessions/session-run-error-presentation.js";
import {
  parseAssistantTextSignature,
  resolveAssistantMessagePhase,
} from "../shared/chat-message-content.js";
import {
  isToolHistoryBlockType,
  isToolResultHistoryBlockType,
  messageHasToolResultShape,
  projectToolResultDetails,
} from "./chat-display-projection.canvas.js";
import { projectAssistantCommentaryFallbacks } from "./chat-display-projection.commentary.js";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  extractAssistantTextForSilentCheck,
  hasAssistantDisplayableNonTextContent,
  hasTranscriptMediaFacts,
  isAssistantTextContentType,
  isProjectedForwardedMessage,
  shouldPreserveAssistantControlReplyText,
  stripAssistantMediaDirectivesForDisplay,
  stripPrivateToolCallContextForDisplay,
  takeAssistantManagedMediaUrlsForDisplay,
  truncateChatHistoryText,
} from "./chat-display-projection.helpers.js";
import {
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "./control-reply-text.js";
import {
  projectWorkspaceResultConflict,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";

const MEDIA_PRIVATE_FIELDS = ["data", "blob", "path", "file", "filePath", "localPath"] as const;
const MEDIA_REFERENCE_FIELDS = ["url", "openUrl", "image_url", "audio_url", "video_url"] as const;
const MEDIA_FACT_PRIVATE_FIELDS = [
  "workspaceDir",
  ...MEDIA_PRIVATE_FIELDS.filter((field) => field !== "path"),
] as const;

function projectChatHistoryMediaReference(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const reference = value.trim();
  if (/^\/(?:api\/chat\/media\/outgoing|media|__openclaw__)\//u.test(reference)) {
    return reference.split(/[?#]/u, 1)[0];
  }
  try {
    if (/^media:/iu.test(reference)) {
      return parseInboundMediaUri(reference)?.normalizedSource;
    }
    const url = new URL(reference);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.username = url.password = url.search = url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function projectChatHistoryMediaBlock(entry: Record<string, unknown>, fact = false): boolean {
  if (!fact && (typeof entry.type !== "string" || !/^(?:image|audio|video)$/u.test(entry.type))) {
    return false;
  }
  const media = entry as typeof entry & { type: "image" | "audio" | "video" };
  const hasTopLevelPayload = typeof media.data === "string" || typeof media.blob === "string";
  const source = fact ? undefined : readRecord(media.source);
  const projectedSource = source ? { ...source } : undefined;
  const records: Record<string, unknown>[] = [media, ...(projectedSource ? [projectedSource] : [])];
  if (projectedSource) {
    media.source = projectedSource;
  }
  const privateFields = fact ? MEDIA_FACT_PRIVATE_FIELDS : MEDIA_PRIVATE_FIELDS;
  const referenceFields = fact ? (["path", "url"] as const) : MEDIA_REFERENCE_FIELDS;
  const sourceIsReference =
    !source &&
    (!fact ||
      typeof media.source !== "string" ||
      /^(?:[a-z][a-z0-9+.-]*:|~?[\\/])|[\\/]/iu.test(media.source));
  let encodedPayload: string | undefined;
  for (const record of records) {
    let omitted = false;
    const payload = typeof record.data === "string" ? record.data : record.blob;
    if (encodedPayload === undefined && typeof payload === "string") {
      encodedPayload = payload;
    }
    for (const field of privateFields) {
      if (!Object.hasOwn(record, field)) {
        continue;
      }
      delete record[field];
      omitted = true;
    }
    const recordReferences =
      record === media && sourceIsReference ? [...referenceFields, "source"] : referenceFields;
    for (const field of recordReferences) {
      if (!Object.hasOwn(record, field)) {
        continue;
      }
      // Managed inbound file paths persisted on media facts are host-local absolute
      // paths; rewrite them to canonical `media://inbound/<id>` URIs the UI loads through
      // the authenticated assistant-media route, instead of redacting the reference entirely.
      const inboundUri = fact ? buildInboundMediaUriFromPath(String(record[field])) : undefined;
      const projected = inboundUri ?? projectChatHistoryMediaReference(record[field]);
      record[field] = projected;
      if (projected === undefined) {
        delete record[field];
        omitted = true;
      }
    }
    if (!fact && omitted) {
      // Preserve shipped image/audio omission ownership; new video blocks mark both levels.
      if (record === media || media.type !== "image") {
        record.omitted = true;
      }
      if (record === media || media.type !== "audio") {
        media.omitted = true;
      }
    }
  }
  if (!fact && encodedPayload !== undefined) {
    (media.type === "audio" && !hasTopLevelPayload && projectedSource
      ? projectedSource
      : media
    ).bytes = estimateBase64DecodedBytes(encodedPayload);
  }
  return true;
}

function projectChatHistoryAttachmentBlock(entry: Record<string, unknown>): boolean {
  if (entry.type !== "attachment") {
    return false;
  }
  const attachment = readRecord(entry.attachment);
  if (!attachment) {
    return false;
  }
  const projected = { ...attachment };
  for (const field of MEDIA_PRIVATE_FIELDS) {
    delete projected[field];
  }
  const url = projectChatHistoryMediaReference(projected.url);
  if (!url) {
    delete projected.url;
  } else {
    projected.url = url;
  }
  entry.attachment = projected;
  return true;
}

function projectChatHistoryMediaFacts(value: unknown): unknown[] | undefined {
  return Array.isArray(value)
    ? value.map((fact) => {
        const projected = { ...readRecord(fact) };
        projectChatHistoryMediaBlock(projected, true);
        return projected;
      })
    : undefined;
}

export function sanitizeChatHistoryContentBlock(
  block: unknown,
  opts?: { preserveExactToolPayload?: boolean; maxChars?: number },
): { block: unknown; changed: boolean; truncated: boolean } {
  if (!block || typeof block !== "object") {
    return { block, changed: false, truncated: false };
  }
  const entry = { ...(block as Record<string, unknown>) };
  let changed = stripPrivateToolCallContextForDisplay(entry);
  // Display-cap truncation is a fact consumers need (to fetch the full row), so
  // it is tracked apart from `changed`, which also covers metadata stripping.
  let truncated = false;
  const preserveExactToolPayload =
    opts?.preserveExactToolPayload === true || isToolHistoryBlockType(entry.type);
  const maxChars = opts?.maxChars ?? DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  if (isToolResultHistoryBlockType(entry.type) && "details" in entry) {
    const projectedDetails = projectToolResultDetails(entry.details, maxChars);
    if (projectedDetails.details) {
      entry.details = projectedDetails.details;
    } else {
      delete entry.details;
    }
    changed = true;
    truncated ||= projectedDetails.truncated;
  }
  if (preserveExactToolPayload && Array.isArray(entry.content)) {
    // Some transcripts carry both nested output blocks and their joined text.
    // Keep one representation, and apply the same media privacy rules recursively.
    const text = entry.content
      .flatMap((item) => {
        const value = readRecord(item)?.text;
        return typeof value === "string" ? [value] : [];
      })
      .join("\n");
    if (entry.text === text) {
      delete entry.text;
      changed = true;
    }
    const content = entry.content.map((item) =>
      sanitizeChatHistoryContentBlock(item, { preserveExactToolPayload: true, maxChars }),
    );
    if (content.some((item) => item.changed)) {
      entry.content = content.map((item) => item.block);
      changed = true;
    }
    truncated ||= content.some((item) => item.truncated);
  }
  for (const field of ["text", "content", "partialJson", "arguments", "thinking"] as const) {
    if (
      typeof entry[field] !== "string" ||
      (preserveExactToolPayload && (field === "partialJson" || field === "arguments"))
    ) {
      continue;
    }
    const res = truncateChatHistoryText(
      entry[field],
      maxChars,
      preserveExactToolPayload && (field === "text" || field === "content"),
    );
    entry[field] = res.text;
    changed ||= res.truncated;
    truncated ||= res.truncated;
  }
  for (const field of ["thinkingSignature", "openclawReasoningReplay"]) {
    if (field in entry) {
      delete entry[field];
      changed = true;
    }
  }
  const mediaChanged = projectChatHistoryMediaBlock(entry);
  const attachmentChanged = projectChatHistoryAttachmentBlock(entry);
  changed ||= mediaChanged || attachmentChanged;
  return { block: changed ? entry : block, changed, truncated };
}

function sanitizeAssistantPhasedContentBlocks(content: unknown[]): {
  content: unknown[];
  changed: boolean;
} {
  const hasExplicitPhasedText = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    return isAssistantTextContentType(entry.type) && parseAssistantTextSignature(entry)?.phase;
  });
  if (!hasExplicitPhasedText) {
    return { content, changed: false };
  }
  const filtered = content.filter((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const entry = block as { type?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentType(entry.type)) {
      return true;
    }
    return parseAssistantTextSignature(entry)?.phase === "final_answer";
  });
  return {
    content: filtered,
    changed: filtered.length !== content.length,
  };
}

function projectAssistantMixedToolContent(
  content: unknown[],
  maxChars: number,
): { content: unknown[]; changed: boolean } | null {
  const hasToolHistoryBlock = content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    return isToolHistoryBlockType((block as { type?: unknown }).type);
  });
  if (!hasToolHistoryBlock) {
    return null;
  }

  let hasVisibleText = false;
  const projectedContent: unknown[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown; textSignature?: unknown };
    if (!isAssistantTextContentType(entry.type)) {
      projectedContent.push(block);
      continue;
    }
    if (parseAssistantTextSignature(entry)?.phase === "commentary") {
      continue;
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      continue;
    }
    const truncated = truncateChatHistoryText(entry.text, maxChars);
    if (truncated.text.trim()) {
      projectedContent.push({ type: "text", text: truncated.text });
      hasVisibleText = true;
    }
  }

  // Mixed messages supply both the visible bubble and its reasoning/tool trace.
  // Keep structured siblings or a history reload loses activity shown while live.
  return hasVisibleText ? { content: projectedContent, changed: true } : null;
}

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const USAGE_FIELDS = [
  "input",
  "output",
  "total",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "promptTokens",
  "completionTokens",
  "cacheRead",
  "cacheWrite",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "input_tokens",
  "output_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
] as const;

function sanitizeNumericMetadata(
  raw: unknown,
  fields: readonly string[],
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of fields) {
    const value = asFiniteNumber(record[key]);
    if (value !== undefined) {
      projected[key] = value;
    }
  }
  if (
    fields === USAGE_FIELDS &&
    "cost" in record &&
    record.cost != null &&
    typeof record.cost === "object"
  ) {
    const cost = sanitizeNumericMetadata(record.cost, COST_FIELDS);
    if (cost) {
      projected.cost = cost;
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectWorkspaceConflictDetails(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (entry.role !== "custom" || entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
    return undefined;
  }
  const details = readRecord(entry.details);
  if (
    !details ||
    !Array.isArray(details.paths) ||
    details.paths.length === 0 ||
    !details.paths.every(
      (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
    ) ||
    typeof details.stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef) ||
    (details.totalCount !== undefined &&
      (!Number.isSafeInteger(details.totalCount) ||
        (details.totalCount as number) < details.paths.length))
  ) {
    return undefined;
  }
  try {
    return projectWorkspaceResultConflict(
      details.paths,
      details.stagedResultRef,
      details.totalCount as number | undefined,
    );
  } catch {
    return undefined;
  }
}

export function sanitizeChatHistoryMessage(
  message: unknown,
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
): { message: unknown; changed: boolean } {
  if (!message || typeof message !== "object") {
    return { message, changed: false };
  }
  const entry = { ...(message as Record<string, unknown>) };
  let changed = false;
  let truncated = false;
  if ("providerReplay" in entry) {
    delete entry.providerReplay;
    changed = true;
  }
  const openClawMeta = readRecord(entry["__openclaw"]);
  if (openClawMeta && ("upstreamUserText" in openClawMeta || "media" in openClawMeta)) {
    // Codex retains the decorated upstream prompt for transcript reconstruction.
    // It is not display data and can otherwise evict the visible row from history.
    const projectedMeta = { ...openClawMeta };
    delete projectedMeta.upstreamUserText;
    if ("media" in projectedMeta) {
      projectedMeta.media = projectChatHistoryMediaFacts(projectedMeta.media);
      if (projectedMeta.media === undefined) {
        delete projectedMeta.media;
      }
    }
    if (Object.keys(projectedMeta).length > 0) {
      entry["__openclaw"] = projectedMeta;
    } else {
      delete entry["__openclaw"];
    }
    changed = true;
  }
  const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
  const managedMedia = takeAssistantManagedMediaUrlsForDisplay(entry, role);
  changed ||= managedMedia.changed;
  const preserveExactToolPayload =
    role === "toolresult" ||
    role === "tool_result" ||
    role === "tool" ||
    role === "function" ||
    typeof entry.toolName === "string" ||
    typeof entry.tool_name === "string" ||
    typeof entry.toolCallId === "string" ||
    typeof entry.tool_call_id === "string";

  if ("details" in entry) {
    const conflictDetails = projectWorkspaceConflictDetails(entry);
    const toolResultDetails =
      !conflictDetails && messageHasToolResultShape(entry)
        ? projectToolResultDetails(entry.details, maxChars)
        : undefined;
    // Only the terminal owner's presentation category crosses this report boundary.
    // Correlation is projected separately; raw diagnostics and report fields stay private.
    const runFailureDetails =
      entry.role === "custom" &&
      entry.customType === "run-failed-before-reply" &&
      readRecord(entry.details)?.errorKind === "state_contention"
        ? { errorKind: "state_contention", diagnostic: STATE_CONTENTION_DIAGNOSTIC }
        : undefined;
    const projectedDetails = conflictDetails ?? toolResultDetails?.details ?? runFailureDetails;
    if (projectedDetails) {
      entry.details = projectedDetails;
    } else {
      delete entry.details;
    }
    changed = true;
    truncated ||= toolResultDetails?.truncated === true;
  }

  for (const field of ["usage", "cost"] as const) {
    if (!(field in entry)) {
      continue;
    }
    const sanitized =
      entry.role === "assistant"
        ? sanitizeNumericMetadata(entry[field], field === "usage" ? USAGE_FIELDS : COST_FIELDS)
        : undefined;
    if (sanitized) {
      entry[field] = sanitized;
    } else {
      delete entry[field];
    }
    changed = true;
  }

  const stripAssistantControlTokens =
    role === "assistant" && !shouldPreserveAssistantControlReplyText(entry);

  const projectText = (text: string) => {
    const controlStripped = stripAssistantControlTokens
      ? stripAssistantMediaDirectivesForDisplay(
          stripSuppressedControlReplyToken(text),
          managedMedia.urls,
        )
      : text;
    changed ||= controlStripped !== text;
    const res = truncateChatHistoryText(controlStripped, maxChars, preserveExactToolPayload);
    changed ||= res.truncated;
    truncated ||= res.truncated;
    return res.text;
  };
  if (typeof entry.content === "string") {
    entry.content = projectText(entry.content);
  } else if (Array.isArray(entry.content)) {
    const content = entry.content;
    const commentary = readRecord(entry.openclawStreamFallback)?.source === "segment";
    let remainingText = maxChars;
    let updated: unknown[] | undefined;
    for (let index = 0; index < content.length; index++) {
      const rawBlock = commentary ? readRecord(content[index]) : undefined;
      const rawText =
        rawBlock && isAssistantTextContentType(rawBlock.type) && typeof rawBlock.text === "string"
          ? rawBlock.text
          : undefined;
      if (rawText !== undefined && remainingText <= 0) {
        updated ??= content.slice();
        updated[index] = undefined;
        truncated ||= rawText.length > 0;
        continue;
      }
      const sanitized = sanitizeChatHistoryContentBlock(content[index], {
        preserveExactToolPayload,
        maxChars: rawText === undefined ? maxChars : remainingText,
      });
      if (rawText !== undefined) {
        remainingText -= rawText.length + 1;
      }
      const contentBlock = stripAssistantControlTokens ? readRecord(sanitized.block) : undefined;
      if (
        contentBlock &&
        isAssistantTextContentType(contentBlock.type) &&
        typeof contentBlock.text === "string"
      ) {
        const text = stripAssistantMediaDirectivesForDisplay(
          stripSuppressedControlReplyToken(contentBlock.text),
          managedMedia.urls,
        );
        if (text !== contentBlock.text) {
          sanitized.block = { ...contentBlock, text };
          sanitized.changed = true;
        }
      }
      if (sanitized.changed) {
        updated ??= content.slice();
        updated[index] = sanitized.block;
      }
      truncated ||= sanitized.truncated;
    }
    if (updated) {
      entry.content = commentary ? updated.filter((block) => block !== undefined) : updated;
      changed = true;
    }
    if (entry.role === "assistant" && Array.isArray(entry.content)) {
      const mixedToolContent = projectAssistantMixedToolContent(entry.content, maxChars);
      if (mixedToolContent) {
        entry.content = mixedToolContent.content;
        if (entry.phase === "commentary") {
          delete entry.phase;
        }
        changed = true;
      } else {
        const sanitizedPhases = sanitizeAssistantPhasedContentBlocks(entry.content);
        if (sanitizedPhases.changed) {
          entry.content = sanitizedPhases.content;
          changed = true;
        }
      }
    }
  }

  if (typeof entry.text === "string") {
    entry.text = projectText(entry.text);
  }

  if (truncated) {
    // Record the display cap where it is applied so any session.message or
    // chat.history consumer can tell a bounded preview from the full row and
    // fetch it via chat.message.get. An upstream "oversized" transcript
    // marker already explains the truncation; never overwrite its reason.
    const meta = readRecord(entry["__openclaw"]);
    entry["__openclaw"] = {
      ...meta,
      truncated: true,
      reason: typeof meta?.reason === "string" ? meta.reason : "display-cap",
    };
    changed = true;
  }

  return { message: changed ? entry : message, changed };
}

function hasAssistantMixedToolVisibleText(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  let hasToolHistoryBlock = false;
  let hasText = false;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as { type?: unknown; text?: unknown };
    if (isToolHistoryBlockType(entry.type)) {
      hasToolHistoryBlock = true;
    }
    if (
      isAssistantTextContentType(entry.type) &&
      typeof entry.text === "string" &&
      entry.text.trim()
    ) {
      hasText = true;
    }
  }
  return hasToolHistoryBlock && hasText;
}

export function shouldDropAssistantHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const entry = message as Record<string, unknown> & { role?: unknown };
  if (entry.role !== "assistant") {
    return false;
  }
  if (isProjectedForwardedMessage(entry)) {
    return false;
  }
  if (resolveAssistantMessagePhase(message) === "commentary") {
    return !hasAssistantMixedToolVisibleText(message);
  }
  const text = extractAssistantTextForSilentCheck(message);
  if (text === undefined || !isSuppressedControlReplyText(text)) {
    return false;
  }
  return !hasAssistantDisplayableNonTextContent(message);
}

export function sanitizeChatHistoryMessages(
  messages: unknown[],
  maxChars: number = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  opts?: { includeCommentaryFallbacks?: boolean },
): unknown[] {
  if (messages.length === 0) {
    return messages;
  }
  let changed = false;
  const next: unknown[] = [];
  for (const original of messages) {
    let message = original;
    if (opts?.includeCommentaryFallbacks === true) {
      const projection = projectAssistantCommentaryFallbacks(message, maxChars);
      message = projection.message;
      changed ||= message !== original;
      for (const commentary of projection.fallbacks) {
        changed = true;
        const hasMediaFacts = hasTranscriptMediaFacts(readRecord(commentary) ?? {});
        if (!hasMediaFacts && shouldDropAssistantHistoryMessage(commentary)) {
          continue;
        }
        const projected = sanitizeChatHistoryMessage(commentary, maxChars);
        if (hasMediaFacts || !shouldDropAssistantHistoryMessage(projected.message)) {
          next.push(projected.message);
        }
      }
    }
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    if (res.changed && shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}
