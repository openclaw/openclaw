import {
  OPENAI_RESPONSES_APIS,
  readOpenAIResponsesCompactionWindow,
} from "@openclaw/ai/internal/openai-responses-payload-policy";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSensitiveText } from "../logging/redact.js";
import { resolveProviderEndpoint, type ProviderEndpointClass } from "./provider-attribution.js";
import { redactTranscriptText } from "./transcript-redact-text.js";

export function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export type TranscriptAssistantRoute = {
  api?: string;
  endpointClass?: ProviderEndpointClass;
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
const GOOGLE_THOUGHT_SIGNATURE_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
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

function isGoogleOpenAICompletionsRoute(route: TranscriptAssistantRoute | undefined): boolean {
  return (
    isOpenAICompletionsRoute(route) &&
    (route?.provider === "google" ||
      route?.endpointClass === "google-generative-ai" ||
      route?.endpointClass === "google-vertex")
  );
}

function isVeniceGeminiOpenAICompletionsRoute(
  route: TranscriptAssistantRoute | undefined,
): boolean {
  return (
    isOpenAICompletionsRoute(route) &&
    route?.provider === "venice" &&
    typeof route.model === "string" &&
    /(?:^|\/)gemini-/.test(route.model.trim().toLowerCase())
  );
}

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

function isStructurallyValidOpaqueReplayToken(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    OPAQUE_REPLAY_TOKEN_RE.test(value) &&
    !value.includes("\u2026")
  );
}

function isCredentialSafeOpaqueReplayToken(value: string): boolean {
  if (!isStructurallyValidOpaqueReplayToken(value)) {
    return false;
  }
  // OpenAI encrypted reasoning is commonly Fernet-shaped and intentionally
  // matches the generic gAAAA secret detector. Custom routes retain the
  // credential-sensitive gate because their opaque fields are not attributable
  // to a known provider contract.
  return value.startsWith("gAAAA") || redactSensitiveText(value, { mode: "tools" }) === value;
}

function isGoogleThoughtSignature(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\u2026") &&
    GOOGLE_THOUGHT_SIGNATURE_RE.test(value)
  );
}

export function resolveTranscriptAssistantRoute(
  source: Record<string, unknown>,
  cfg: OpenClawConfig | undefined,
): TranscriptAssistantRoute {
  const api = typeof source.api === "string" ? source.api : undefined;
  const model = typeof source.model === "string" ? source.model : undefined;
  const provider = typeof source.provider === "string" ? source.provider : undefined;
  const providerConfig = provider
    ? findNormalizedProviderValue(cfg?.models?.providers, provider)
    : undefined;
  const modelConfig = model
    ? providerConfig?.models?.find((candidate) => candidate.id === model)
    : undefined;
  const baseUrl = modelConfig?.baseUrl ?? providerConfig?.baseUrl;
  const endpointClass = baseUrl ? resolveProviderEndpoint(baseUrl).endpointClass : undefined;
  return {
    ...(api ? { api } : {}),
    ...(endpointClass ? { endpointClass } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
}

function isSafeReplayIdentifier(value: string, maxLength = 512): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    /^[A-Za-z0-9+/_:.=-]+$/.test(value) &&
    redactSensitiveText(value, { mode: "tools" }) === value
  );
}

function isOpenAIResponseItemId(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  return isSafeReplayIdentifier(value, isGitHubCopilotResponsesRoute(route) ? 64 : 512);
}

function isOpenAITextSignature(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  if (value.startsWith("{")) {
    try {
      const parsed = safeParseJsonRecord(value);
      if (!parsed) {
        return false;
      }
      if (!Object.keys(parsed).every((key) => key === "v" || key === "id" || key === "phase")) {
        return false;
      }
      const id =
        typeof parsed.id === "string" && isOpenAIResponseItemId(parsed.id, route)
          ? parsed.id
          : undefined;
      const phase =
        parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : undefined;
      if (parsed.id !== undefined && id === undefined) {
        return false;
      }
      return parsed.v === 1 && (id !== undefined || phase !== undefined);
    } catch {
      return false;
    }
  }
  return isOpenAIResponseItemId(value, route);
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

function shouldPreserveOpaqueProviderPayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  route: TranscriptAssistantRoute | undefined,
): boolean {
  if (typeof item !== "string") {
    return false;
  }
  const type = source.type;
  const isAnthropicSlot =
    (type === "thinking" && (key === "thinkingSignature" || key === "signature")) ||
    (type === "redacted_thinking" &&
      (key === "data" || key === "signature" || key === "thinkingSignature"));
  if (isAnthropicReasoningRoute(route) && isAnthropicSlot) {
    return isStructurallyValidOpaqueReplayToken(item);
  }
  const isGoogleSlot =
    (type === "text" && key === "textSignature") ||
    (type === "thinking" && (key === "thinkingSignature" || key === "thought_signature")) ||
    (type === "toolCall" && key === "thoughtSignature");
  if (isGoogleReasoningRoute(route) && isGoogleSlot) {
    return isGoogleThoughtSignature(item);
  }
  if (
    (isGoogleOpenAICompletionsRoute(route) || isVeniceGeminiOpenAICompletionsRoute(route)) &&
    type === "toolCall" &&
    key === "thoughtSignature"
  ) {
    // The OpenAI-compatible transport captures provider-owned opaque signatures
    // such as SIG-OPAQUE-ABC==; native Google routes require standard base64.
    return isStructurallyValidOpaqueReplayToken(item);
  }
  if (!isCustomProviderRoute(route) || !isCredentialSafeOpaqueReplayToken(item)) {
    return false;
  }
  return isAnthropicSlot || isGoogleSlot;
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
  const isValidEncryptedContent = isOpenAIResponsesRoute(route)
    ? isStructurallyValidOpaqueReplayToken
    : isCredentialSafeOpaqueReplayToken;
  if (
    encryptedContent !== undefined &&
    encryptedContent !== null &&
    (typeof encryptedContent !== "string" || !isValidEncryptedContent(encryptedContent))
  ) {
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
  if (!hasEncryptedContent && typeof parsed.id !== "string") {
    return undefined;
  }
  const replayMetadata = sanitizeOpenAIReasoningReplayMetadata(
    parsed[OPENAI_REASONING_REPLAY_METADATA_KEY],
    route,
  );
  return JSON.stringify({
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    type: "reasoning",
    summary: [],
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(hasEncryptedContent ? { encrypted_content: encryptedContent } : {}),
    ...(replayMetadata ? { [OPENAI_REASONING_REPLAY_METADATA_KEY]: replayMetadata } : {}),
  });
}

function sanitizeOpenAICompletionsToolSignature(
  value: string,
  route: TranscriptAssistantRoute | undefined,
): string | undefined {
  const parsed = safeParseJsonRecord(value);
  const isValidEncryptedData = isOpenAICompletionsRoute(route)
    ? isStructurallyValidOpaqueReplayToken
    : isCredentialSafeOpaqueReplayToken;
  if (
    !parsed ||
    parsed.type !== "reasoning.encrypted" ||
    typeof parsed.data !== "string" ||
    !isValidEncryptedData(parsed.data) ||
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

/** Preserve only provider-owned replay fields from a direct assistant content block. */
export function sanitizeAssistantReplayField(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  route: TranscriptAssistantRoute | undefined,
): unknown {
  if (source.type === "thinking") {
    if (
      (isOpenAIResponsesRoute(route) || isCustomProviderRoute(route)) &&
      key === "openclawReasoningReplay"
    ) {
      const metadata = sanitizeOpenAIReasoningReplayMetadata(item, route);
      if (metadata !== undefined) {
        return metadata;
      }
    }
    if (key === "thinkingSignature" && typeof item === "string") {
      const signature = sanitizeOpenAIReasoningSignature(item, route);
      if (signature !== undefined) {
        return signature;
      }
    }
  }
  if (
    // These transports use the same v1 phase signature for pre-tool commentary.
    (isOpenAIResponsesRoute(route) ||
      isOpenAICompletionsRoute(route) ||
      isAnthropicReasoningRoute(route) ||
      isCustomProviderRoute(route)) &&
    source.type === "text" &&
    key === "textSignature" &&
    typeof item === "string" &&
    isOpenAITextSignature(item, route)
  ) {
    return item;
  }
  if (
    (isOpenAICompletionsRoute(route) || isCustomProviderRoute(route)) &&
    source.type === "toolCall" &&
    key === "thoughtSignature" &&
    typeof item === "string"
  ) {
    const signature = sanitizeOpenAICompletionsToolSignature(item, route);
    if (signature !== undefined) {
      return signature;
    }
  }
  return shouldPreserveOpaqueProviderPayload(source, key, item, route) ? item : undefined;
}

function sanitizeCompactedWindow(
  replay: { data: string; id?: string; compactedWindow?: unknown },
  cfg: OpenClawConfig | undefined,
  redactStructuredValue: (value: unknown, cfg?: OpenClawConfig) => unknown,
) {
  const window = replay.compactedWindow;
  const output = readOpenAIResponsesCompactionWindow(replay);
  const unchanged = output?.every((item) => {
    if (item.type !== "compaction") {
      return redactStructuredValue(item, cfg) === item;
    }
    // Only the encrypted token is opaque; optional provider fields still pass
    // through the same plaintext policy as the retained messages.
    const { encrypted_content: _encrypted, ...plaintext } = item;
    return redactStructuredValue(plaintext, cfg) === plaintext;
  });
  return unchanged &&
    window &&
    typeof window === "object" &&
    isPlainTranscriptObject(window) &&
    typeof window.output === "string"
    ? { state: "ready", output: window.output }
    : { state: "refresh-required" };
}

export function sanitizeCompactionReplayState(
  value: unknown,
  route: TranscriptAssistantRoute | undefined,
  cfg: OpenClawConfig | undefined,
  redactStructuredValue: (value: unknown, cfg?: OpenClawConfig) => unknown,
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
    typeof value.data !== "string" ||
    (value.type === "openai-responses-retained-compaction" && value.replayIndex !== undefined) ||
    (value.replayIndex !== undefined &&
      (isSuppression ||
        !Number.isSafeInteger(value.replayIndex) ||
        (value.replayIndex as number) < 0)) ||
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
      : value.data.length > 0
        ? redactTranscriptText(value.data, cfg)
        : undefined;
  if (data === undefined) {
    return undefined;
  }
  const encryptedContent = !isSuppression && isAnthropic ? value.encryptedContent : undefined;
  if (
    encryptedContent !== undefined &&
    encryptedContent !== null &&
    (typeof encryptedContent !== "string" ||
      !isStructurallyValidOpaqueReplayToken(encryptedContent))
  ) {
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
          // Keep the newest fenced barrier when its canonical plaintext cannot
          // survive redaction; dropping it could expose an older checkpoint.
          compactedWindow: sanitizeCompactedWindow(
            { data, id: replayId, compactedWindow: value.compactedWindow },
            cfg,
            redactStructuredValue,
          ),
        }
      : {}),
  };
}
