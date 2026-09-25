import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { RealtimeVoiceProviderConfig } from "../../talk/provider-types.js";
import type { GatewayClient } from "../server-methods/types.js";

export const TALK_TRANSCRIPTION_COMMAND_HINTS = {
  version: 1,
  kind: "local-stop-phrases",
  mode: "realtime",
  transport: "gateway-relay",
  models: ["gpt-realtime-2.1"],
  transcriptionModel: "gpt-4o-mini-transcribe",
  maxPhrases: 8,
  maxPhraseUtf16Units: 64,
  maxTotalUtf16Units: 256,
  maxPromptUtf8Bytes: 1024,
} as const;

export const INVALID_TALK_TRANSCRIPTION_HINTS = "Invalid transcription command hints";

/** Validate before generic RPC errors can include caller-supplied phrase/property text. */
export function parseTalkTranscriptionHintPhrases(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const invalid = (): never => {
    throw new Error(INVALID_TALK_TRANSCRIPTION_HINTS);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  // SAFETY: The guard above establishes a non-null, non-array object; fields remain unknown until validated below.
  const hints = value as Record<string, unknown>;
  if (
    Object.keys(hints).toSorted().join(",") !== "kind,phrases,version" ||
    hints.version !== 1 ||
    hints.kind !== "local-stop-phrases" ||
    !Array.isArray(hints.phrases) ||
    hints.phrases.length > TALK_TRANSCRIPTION_COMMAND_HINTS.maxPhrases
  ) {
    return invalid();
  }
  let total = 0;
  const phrases: string[] = [];
  for (const phrase of hints.phrases) {
    if (
      typeof phrase !== "string" ||
      phrase.length < 1 ||
      phrase.length > TALK_TRANSCRIPTION_COMMAND_HINTS.maxPhraseUtf16Units ||
      phrase.trim() !== phrase ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(phrase)
    ) {
      return invalid();
    }
    total += phrase.length;
    if (total > TALK_TRANSCRIPTION_COMMAND_HINTS.maxTotalUtf16Units) {
      return invalid();
    }
    if (!phrases.includes(phrase)) {
      phrases.push(phrase);
    }
  }
  return phrases;
}

type HintRoute = {
  mode: string;
  transport: string;
  providerId: string;
  providerConfig: RealtimeVoiceProviderConfig;
  model?: string;
};

/** Feature filtering on an authenticated connection never replaces RPC authority. */
export function supportsTalkTranscriptionCommandHints(
  client: GatewayClient | null,
  route: HintRoute,
): boolean {
  return (
    Boolean(client?.connId) &&
    client?.connect?.role === "operator" &&
    client.connect.client?.id === GATEWAY_CLIENT_IDS.MACOS_APP &&
    client.connect.client.mode === GATEWAY_CLIENT_MODES.UI &&
    route.mode === "realtime" &&
    route.transport === "gateway-relay" &&
    route.providerId === "openai" &&
    (route.providerConfig.model ?? route.model) === "gpt-realtime-2.1" &&
    !route.providerConfig.azureEndpoint &&
    !route.providerConfig.azureDeployment &&
    !route.providerConfig.gaSessionPolicy
  );
}

/** A validated nonempty request is the opt-in; never add defaults or aliases. */
export function buildTalkCommandTranscriptionPrompt(
  phrases: string[] | undefined,
): string | undefined {
  if (!phrases?.length) {
    return undefined;
  }
  const prompt =
    "Possible literal phrases in this conversation: " +
    JSON.stringify(phrases) +
    ". Transcribe only speech that is present, including surrounding words.";
  if (Buffer.byteLength(prompt, "utf8") > TALK_TRANSCRIPTION_COMMAND_HINTS.maxPromptUtf8Bytes) {
    throw new Error(INVALID_TALK_TRANSCRIPTION_HINTS);
  }
  return prompt;
}
