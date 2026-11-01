import {
  OPENAI_RESPONSES_APIS,
  readOpenAIResponsesCompactionWindow,
} from "@openclaw/ai/internal/openai-responses-payload-policy";
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { cloneTranscriptEnvelope } from "../config/sessions/transcript-json.js";
import type { AgentMessage } from "./runtime/index.js";

const isImageMimeType = (value: unknown): value is string =>
  typeof value === "string" && /^image\//iu.test(value.trim());

function sanitizeTranscriptImageRecord(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const isImageBlock = source.type === "image";
  const isBase64SourceBlock = source.type === "base64";
  if ((!isImageBlock && !isBase64SourceBlock) || typeof source.data !== "string") {
    return undefined;
  }
  const mimeTypeFields = ["mimeType", "mediaType", "media_type"].filter((key) =>
    isImageMimeType(source[key]),
  );
  const mimeType = mimeTypeFields.map((key) => source[key]).find(isImageMimeType);
  if (!mimeType) {
    return undefined;
  }
  const sanitized = sanitizeInlineImageBase64({
    base64: source.data,
    mimeType: mimeType.trim().toLowerCase(),
  });
  if (!sanitized) {
    return undefined;
  }
  const hasCanonicalMimeTypes = mimeTypeFields.every((key) => source[key] === sanitized.mimeType);
  if (source.data === sanitized.base64 && hasCanonicalMimeTypes) {
    return source;
  }
  const next = Object.assign(cloneTranscriptEnvelope(source), { data: sanitized.base64 });
  for (const field of mimeTypeFields) {
    next[field] = sanitized.mimeType;
  }
  return next;
}

function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type TranscriptValueLocation =
  | "root"
  | "assistant-content-array"
  | "assistant-content-block"
  | "nested";

type TranscriptAssistantRoute = {
  api?: string;
  model?: string;
  provider?: string;
};

const GOOGLE_REASONING_APIS = new Set([
  "google-generative-ai",
  "google-interactions",
  "google-vertex",
  "google-gemini-cli",
  "openclaw-google-generative-ai-transport",
]);
const ANTHROPIC_REASONING_APIS = new Set([
  "anthropic-messages",
  "bedrock-converse-stream",
  "openclaw-anthropic-messages-transport",
]);
const OPENAI_COMPLETIONS_APIS = new Set([
  "openai-completions",
  "openclaw-openai-completions-transport",
]);
const OPAQUE_REPLAY_TOKEN_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
// Transport replay fences use the two-word base-36 output from shortHash.
const OPENAI_REPLAY_CONTEXT_HASH_RE = /^[a-z0-9]{2,16}$/;

function isOpenAIReplayContextHash(value: unknown): value is string {
  return typeof value === "string" && OPENAI_REPLAY_CONTEXT_HASH_RE.test(value);
}

function isOpenAIResponsesApi(api: string): boolean {
  return OPENAI_RESPONSES_APIS.has(api);
}

function isOpenAIResponsesRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && isOpenAIResponsesApi(route.api);
}

function isGoogleReasoningRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && GOOGLE_REASONING_APIS.has(route.api);
}

function isAnthropicReasoningRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return typeof route?.api === "string" && ANTHROPIC_REASONING_APIS.has(route.api);
}

const isOpenAICompletionsRoute = (route?: TranscriptAssistantRoute) =>
  OPENAI_COMPLETIONS_APIS.has(route?.api ?? "");

function isCustomProviderRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    Boolean(route?.api && route.model && route.provider) &&
    route?.api !== "mistral-conversations" &&
    !isOpenAIResponsesRoute(route) &&
    !isGoogleReasoningRoute(route) &&
    !isAnthropicReasoningRoute(route) &&
    !isOpenAICompletionsRoute(route)
  );
}

function isGitHubCopilotResponsesRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    (route?.api === "openai-responses" || route?.api === "openclaw-openai-responses-transport") &&
    route.provider === "github-copilot"
  );
}

function isStructurallyValidOpaqueReplayToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    OPAQUE_REPLAY_TOKEN_RE.test(value) &&
    !value.includes("\u2026")
  );
}

function resolveTranscriptAssistantRoute(
  source: Record<string, unknown>,
): TranscriptAssistantRoute {
  const api = typeof source.api === "string" ? source.api : undefined;
  const model = typeof source.model === "string" ? source.model : undefined;
  const provider = typeof source.provider === "string" ? source.provider : undefined;
  return {
    ...(api ? { api } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

function isSafeReplayIdentifier(value: string, maxLength = 512): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    /^[A-Za-z0-9+/_:.=-]+$/.test(value)
  );
}

function isOpenAIResponseItemId(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  return isSafeReplayIdentifier(value, isGitHubCopilotResponsesRoute(route) ? 64 : 512);
}

function sanitizeCompactedWindow(replay: { data: string; id?: string; compactedWindow?: unknown }) {
  const window = replay.compactedWindow;
  const output = readOpenAIResponsesCompactionWindow(replay);
  const unchanged = output?.every((item) => {
    if (item.type !== "compaction") {
      return sanitizeTranscriptStructuredValue(item) === item;
    }
    // Preserve the canonical window only when image normalization leaves it unchanged.
    const { encrypted_content: _encrypted, ...plaintext } = item;
    return sanitizeTranscriptStructuredValue(plaintext) === plaintext;
  });
  return unchanged &&
    window &&
    typeof window === "object" &&
    isPlainTranscriptObject(window) &&
    typeof window.output === "string"
    ? {
        state: "ready",
        output: window.output,
        ...(typeof window.outputTokens === "number" &&
        Number.isSafeInteger(window.outputTokens) &&
        window.outputTokens >= 0
          ? { outputTokens: window.outputTokens }
          : {}),
      }
    : { state: "refresh-required" };
}

function sanitizeCompactionReplayState(
  value: unknown,
  route: TranscriptAssistantRoute | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !isPlainTranscriptObject(value)) {
    return undefined;
  }
  const replayType = typeof value.type === "string" ? value.type : "";
  const openAISuppression = replayType === "openai-responses-compaction-suppression";
  const anthropicSuppression = replayType === "anthropic-compaction-suppression";
  const isOpenAI =
    openAISuppression ||
    replayType === "openai-responses-compaction" ||
    replayType === "openai-responses-retained-compaction";
  const isAnthropic = anthropicSuppression || replayType === "anthropic-compaction";
  const isSuppression = openAISuppression || anthropicSuppression;
  if (
    (!isOpenAI && !isAnthropic) ||
    !(isOpenAI ? isOpenAIResponsesRoute(route) : isAnthropicReasoningRoute(route)) ||
    value.v !== 1 ||
    (value.type === "openai-responses-retained-compaction" && value.replayIndex !== undefined) ||
    (value.replayIndex !== undefined &&
      (isSuppression ||
        typeof value.replayIndex !== "number" ||
        !Number.isSafeInteger(value.replayIndex) ||
        value.replayIndex < 0)) ||
    value.provider !== route?.provider ||
    !(isOpenAI
      ? typeof value.api === "string" && isOpenAIResponsesApi(value.api)
      : value.api === route?.api) ||
    value.model !== route?.model ||
    !isOpenAIReplayContextHash(value.baseUrlHash) ||
    (value.sessionHash !== undefined && !isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined && !isOpenAIReplayContextHash(value.authProfileHash))
  ) {
    return undefined;
  }
  const data = isSuppression
    ? value.data === "rejected"
      ? value.data
      : undefined
    : isOpenAI
      ? isStructurallyValidOpaqueReplayToken(value.data)
        ? value.data
        : undefined
      : typeof value.data === "string" && value.data.length > 0
        ? value.data
        : undefined;
  if (data === undefined) {
    return undefined;
  }
  const encryptedContent = !isSuppression && isAnthropic ? value.encryptedContent : undefined;
  if (encryptedContent != null && !isStructurallyValidOpaqueReplayToken(encryptedContent)) {
    return undefined;
  }
  const replayId =
    !isSuppression &&
    isOpenAI &&
    typeof value.id === "string" &&
    isOpenAIResponseItemId(value.id, route)
      ? value.id
      : undefined;
  return {
    v: 1,
    type: value.type,
    ...(replayId !== undefined ? { id: replayId } : {}),
    data,
    ...(encryptedContent !== undefined ? { encryptedContent } : {}),
    ...(value.replayIndex !== undefined ? { replayIndex: value.replayIndex } : {}),
    provider: value.provider,
    api: value.api,
    model: value.model,
    baseUrlHash: value.baseUrlHash,
    ...(value.sessionHash !== undefined ? { sessionHash: value.sessionHash } : {}),
    ...(value.authProfileHash !== undefined ? { authProfileHash: value.authProfileHash } : {}),
    ...(!isSuppression && isOpenAI && value.compactedWindow !== undefined
      ? {
          // Keep the newest barrier when its canonical image payload needs refreshing.
          compactedWindow: sanitizeCompactedWindow({
            data,
            id: replayId,
            compactedWindow: value.compactedWindow,
          }),
        }
      : {}),
  };
}

const OPENAI_REASONING_REPLAY_METADATA_KEYS = new Set([
  "v",
  "source",
  "provider",
  "api",
  "model",
  "baseUrlHash",
  "sessionHash",
  "authProfileHash",
]);
const OPENAI_REASONING_REPLAY_METADATA_KEY = "__openclaw_replay";

function sanitizeOpenAIReasoningReplayMetadata(
  value: unknown,
  route: TranscriptAssistantRoute | undefined,
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !isPlainTranscriptObject(value) ||
    !route?.api ||
    !route.model ||
    !route.provider
  ) {
    return undefined;
  }
  if (
    value.v !== 1 ||
    value.source !== "openai-responses" ||
    value.provider !== route?.provider ||
    value.api !== route.api ||
    value.model !== route.model ||
    (value.baseUrlHash !== undefined && !isOpenAIReplayContextHash(value.baseUrlHash)) ||
    (value.sessionHash !== undefined && !isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined && !isOpenAIReplayContextHash(value.authProfileHash))
  ) {
    return undefined;
  }
  if (Object.keys(value).every((key) => OPENAI_REASONING_REPLAY_METADATA_KEYS.has(key))) {
    return value;
  }
  return {
    v: 1,
    source: "openai-responses",
    provider: value.provider,
    api: value.api,
    model: value.model,
    ...(value.baseUrlHash !== undefined ? { baseUrlHash: value.baseUrlHash } : {}),
    ...(value.sessionHash !== undefined ? { sessionHash: value.sessionHash } : {}),
    ...(value.authProfileHash !== undefined ? { authProfileHash: value.authProfileHash } : {}),
  };
}

export function sanitizeOpenAIReasoningSignature(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): string | undefined {
  if (!isOpenAIResponsesRoute(route) && !isCustomProviderRoute(route)) {
    return undefined;
  }
  const parsed = safeParseJsonRecord(value);
  if (
    !parsed ||
    parsed.type !== "reasoning" ||
    (parsed.summary !== undefined && !Array.isArray(parsed.summary))
  ) {
    return undefined;
  }
  const encryptedContent = parsed.encrypted_content;
  const hasEncryptedContent = Object.hasOwn(parsed, "encrypted_content");
  if (encryptedContent != null && !isStructurallyValidOpaqueReplayToken(encryptedContent)) {
    return undefined;
  }
  if (
    parsed.id !== undefined &&
    (typeof parsed.id !== "string" ||
      !(isOpenAIResponsesRoute(route)
        ? isSafeReplayIdentifier(parsed.id, Infinity)
        : isOpenAIResponseItemId(parsed.id, route)))
  ) {
    return undefined;
  }
  if (
    parsed.status !== undefined &&
    parsed.status !== "in_progress" &&
    parsed.status !== "completed" &&
    parsed.status !== "incomplete"
  ) {
    return undefined;
  }
  if (!hasEncryptedContent && parsed.id === undefined) {
    return undefined;
  }
  const replayMetadata = sanitizeOpenAIReasoningReplayMetadata(
    parsed[OPENAI_REASONING_REPLAY_METADATA_KEY],
    route,
  );
  return JSON.stringify({
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    type: "reasoning",
    summary: [],
    ...(Array.isArray(parsed.content) && parsed.content.length === 0 ? { content: [] } : {}),
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(hasEncryptedContent ? { encrypted_content: encryptedContent } : {}),
    ...(replayMetadata ? { [OPENAI_REASONING_REPLAY_METADATA_KEY]: replayMetadata } : {}),
  });
}

function sanitizeOpenAICompletionsToolSignature(value: string): string | undefined {
  const parsed = safeParseJsonRecord(value);
  if (
    !parsed ||
    parsed.type !== "reasoning.encrypted" ||
    !isStructurallyValidOpaqueReplayToken(parsed.data) ||
    (parsed.id !== undefined &&
      parsed.id !== null &&
      (typeof parsed.id !== "string" || !isSafeReplayIdentifier(parsed.id))) ||
    (parsed.format !== undefined &&
      parsed.format !== null &&
      (typeof parsed.format !== "string" ||
        parsed.format.length > 64 ||
        !/^[a-z0-9.-]+$/.test(parsed.format))) ||
    (parsed.index !== undefined &&
      (typeof parsed.index !== "number" || !Number.isSafeInteger(parsed.index) || parsed.index < 0))
  ) {
    return undefined;
  }
  return JSON.stringify({
    type: "reasoning.encrypted",
    data: parsed.data,
    ...(parsed.id !== undefined ? { id: parsed.id } : {}),
    ...(parsed.format !== undefined ? { format: parsed.format } : {}),
    ...(parsed.index !== undefined ? { index: parsed.index } : {}),
  });
}

function sanitizeTranscriptStructuredValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  preserveImageDataUrlFields = false,
  location: TranscriptValueLocation = "nested",
  assistantRoute?: TranscriptAssistantRoute,
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    let changed = false;
    const sanitized = value.map((item) => {
      const next = sanitizeTranscriptStructuredValue(
        item,
        seen,
        preserveImageDataUrlFields,
        location === "assistant-content-array" ? "assistant-content-block" : "nested",
        assistantRoute,
      );
      changed ||= next !== item;
      return next;
    });
    seen.delete(value);
    return changed ? sanitized : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    // Circular refs serialize as a stable marker instead of crashing persistence.
    return "[Circular]";
  }
  if (!isPlainTranscriptObject(value)) {
    // Non-plain instances can carry runtime state; leave them untouched instead
    // of cloning unexpected prototypes into transcripts.
    return value;
  }

  seen.add(value);
  const sanitizedImageRecord = sanitizeTranscriptImageRecord(value);
  const source = sanitizedImageRecord ?? value;
  const currentAssistantRoute =
    location === "root" && source.role === "assistant"
      ? resolveTranscriptAssistantRoute(source)
      : assistantRoute;
  let next: Record<string, unknown> | null = source !== value ? source : null;
  for (const [key, item] of Object.entries(source)) {
    if (location === "root" && source.role === "assistant" && key === "providerReplay") {
      const sanitizedReplay = sanitizeCompactionReplayState(item, currentAssistantRoute);
      if (sanitizedReplay !== undefined) {
        if (sanitizedReplay !== item) {
          next ??= cloneTranscriptEnvelope(source);
          next[key] = sanitizedReplay;
        }
        continue;
      }
      next ??= cloneTranscriptEnvelope(source);
      delete next[key];
      continue;
    }
    let sanitizedField: unknown;
    if (
      location === "assistant-content-block" &&
      (isOpenAIResponsesRoute(currentAssistantRoute) ||
        isCustomProviderRoute(currentAssistantRoute)) &&
      source.type === "thinking" &&
      key === "openclawReasoningReplay"
    ) {
      sanitizedField = sanitizeOpenAIReasoningReplayMetadata(item, currentAssistantRoute);
    }
    if (
      sanitizedField === undefined &&
      location === "assistant-content-block" &&
      source.type === "thinking" &&
      key === "thinkingSignature" &&
      typeof item === "string"
    ) {
      sanitizedField = sanitizeOpenAIReasoningSignature(item, currentAssistantRoute);
    }
    if (
      sanitizedField === undefined &&
      location === "assistant-content-block" &&
      (isOpenAICompletionsRoute(currentAssistantRoute) ||
        isCustomProviderRoute(currentAssistantRoute)) &&
      source.type === "toolCall" &&
      key === "thoughtSignature" &&
      typeof item === "string"
    ) {
      sanitizedField = sanitizeOpenAICompletionsToolSignature(item);
    }
    if (
      sanitizedField === undefined &&
      typeof item === "string" &&
      item.slice(0, "data:".length).toLowerCase() === "data:"
    ) {
      const isImageDataUrlField =
        (preserveImageDataUrlFields && key === "url") ||
        (source.type === "input_image" && key === "image_url") ||
        ((source.type === "image" || source.type === "image_url") && key === "url") ||
        (source.type === "image" && (key === "source" || key === "data"));
      sanitizedField = isImageDataUrlField ? sanitizeInlineImageDataUrlForStorage(item) : undefined;
    }
    if (sanitizedField !== undefined) {
      if (sanitizedField !== item) {
        next ??= cloneTranscriptEnvelope(source);
        next[key] = sanitizedField;
      }
      continue;
    }
    if (key === "data" && sanitizedImageRecord) {
      continue;
    }
    const sanitized = sanitizeTranscriptStructuredValue(
      item,
      seen,
      preserveImageDataUrlFields ||
        (key === "image_url" &&
          (source.type === "image_url" ||
            source.type === "input_image" ||
            source.type === "image")),
      location === "root" && source.role === "assistant" && key === "content" && Array.isArray(item)
        ? "assistant-content-array"
        : "nested",
      currentAssistantRoute,
    );
    if (sanitized === item) {
      continue;
    }
    next ??= cloneTranscriptEnvelope(source);
    next[key] = sanitized;
  }
  seen.delete(value);
  return next ?? value;
}

/** Normalize transcript images and provider replay metadata without changing source text. */
export function sanitizeTranscriptMessage(message: AgentMessage): AgentMessage {
  return sanitizeTranscriptStructuredValue(
    message,
    new WeakSet<object>(),
    false,
    "root",
  ) as AgentMessage; // SAFETY: The walk preserves the message envelope and normalizes only media/replay fields.
}
