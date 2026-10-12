import { readOpenAIResponsesCompactionWindow } from "@openclaw/ai/internal/openai-responses-payload-policy";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type TranscriptReplayRoute = {
  api?: string;
  model?: string;
  provider?: string;
};

type TranscriptReplaySanitizerHelpers = {
  isAnthropicReasoningRoute: (route: TranscriptReplayRoute | undefined) => boolean;
  isOpenAIReplayContextHash: (value: unknown) => value is string;
  isOpenAIResponseItemId: (value: string, route: TranscriptReplayRoute | undefined) => boolean;
  isOpenAIResponsesApi: (api: string) => boolean;
  isOpenAIResponsesRoute: (route: TranscriptReplayRoute | undefined) => boolean;
  isPlainTranscriptObject: (value: object) => value is Record<string, unknown>;
  isStructurallyValidOpaqueReplayToken: (value: string) => boolean;
  redactTranscriptStructuredValue: (value: unknown, cfg?: OpenClawConfig) => unknown;
  redactTranscriptText: (value: string, cfg?: OpenClawConfig) => string;
};

function sanitizeCompactedWindow(
  replay: { data: string; id?: string; compactedWindow?: unknown },
  cfg: OpenClawConfig | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
) {
  const window = replay.compactedWindow;
  const output = readOpenAIResponsesCompactionWindow(replay);
  const unchanged = output?.every((item) => {
    if (item.type !== "compaction") {
      return helpers.redactTranscriptStructuredValue(item, cfg) === item;
    }
    // Only the encrypted token is opaque; optional provider fields still pass
    // through the same plaintext policy as the retained messages.
    const { encrypted_content: _encrypted, ...plaintext } = item;
    return helpers.redactTranscriptStructuredValue(plaintext, cfg) === plaintext;
  });
  return unchanged &&
    window &&
    typeof window === "object" &&
    helpers.isPlainTranscriptObject(window) &&
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

export function sanitizeCompactionReplayState(
  value: unknown,
  route: TranscriptReplayRoute | undefined,
  cfg: OpenClawConfig | undefined,
  helpers: TranscriptReplaySanitizerHelpers,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !helpers.isPlainTranscriptObject(value)) {
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
    !(isOpenAI
      ? helpers.isOpenAIResponsesRoute(route)
      : helpers.isAnthropicReasoningRoute(route)) ||
    value.v !== 1 ||
    typeof value.data !== "string" ||
    (value.type === "openai-responses-retained-compaction" && value.replayIndex !== undefined) ||
    (value.replayIndex !== undefined &&
      (isSuppression ||
        !Number.isSafeInteger(value.replayIndex) ||
        (value.replayIndex as number) < 0)) ||
    value.provider !== route?.provider ||
    !(isOpenAI
      ? typeof value.api === "string" && helpers.isOpenAIResponsesApi(value.api)
      : value.api === route?.api) ||
    value.model !== route?.model ||
    !helpers.isOpenAIReplayContextHash(value.baseUrlHash) ||
    (value.sessionHash !== undefined && !helpers.isOpenAIReplayContextHash(value.sessionHash)) ||
    (value.authProfileHash !== undefined &&
      !helpers.isOpenAIReplayContextHash(value.authProfileHash))
  ) {
    return undefined;
  }
  const data = isSuppression
    ? value.data === "rejected"
      ? value.data
      : undefined
    : isOpenAI
      ? helpers.isStructurallyValidOpaqueReplayToken(value.data)
        ? value.data
        : undefined
      : value.data.length > 0
        ? helpers.redactTranscriptText(value.data, cfg)
        : undefined;
  if (data === undefined) {
    return undefined;
  }
  const encryptedContent = !isSuppression && isAnthropic ? value.encryptedContent : undefined;
  if (
    encryptedContent !== undefined &&
    encryptedContent !== null &&
    (typeof encryptedContent !== "string" ||
      !helpers.isStructurallyValidOpaqueReplayToken(encryptedContent))
  ) {
    return undefined;
  }
  const replayId =
    !isSuppression &&
    isOpenAI &&
    typeof value.id === "string" &&
    helpers.isOpenAIResponseItemId(value.id, route)
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
            helpers,
          ),
        }
      : {}),
  };
}
