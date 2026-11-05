import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsConfig, TtsProvider } from "../config/types.tts.js";
import type { PreparedTtsPreferences } from "./tts-preferences.js";
import { resolveTtsSettingsSnapshot } from "./tts-settings.js";

const DEFAULT_OPENAI_TTS_BASE_URL = "https://api.openai.com/v1";
const MAX_STATUS_DETAIL_LENGTH = 96;

type TtsStatusSnapshot = {
  autoMode: TtsAutoMode;
  provider: TtsProvider;
  displayName?: string;
  model?: string;
  voice?: string;
  persona?: string;
  baseUrl?: string;
  customBaseUrl?: boolean;
  maxLength: number;
  summarize: boolean;
};

function normalizeStatusDetail(
  value: unknown,
  maxLength = MAX_STATUS_DETAIL_LENGTH,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxLength
    ? `${truncateUtf16Safe(normalized, maxLength - 3)}...`
    : normalized;
}

function sanitizeBaseUrlForStatus(value: unknown): string | undefined {
  const raw = normalizeStatusDetail(value, 180);
  if (!raw) {
    return undefined;
  }
  const parsed = URL.parse(raw);
  if (!parsed) {
    return "[invalid-url]";
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  const sanitized = parsed.toString().replace(/\/+$/, "");
  return normalizeStatusDetail(sanitized, 120);
}

function resolveStatusProviderDetails(raw: TtsConfig, provider: TtsProvider) {
  if (provider === "auto") {
    return {};
  }
  const providers: Record<string, unknown> = isObjectRecord(raw.providers) ? raw.providers : {};
  let record: Record<string, unknown> = {};
  if (provider === "microsoft") {
    record = {
      ...(isObjectRecord(providers.edge) ? providers.edge : {}),
      ...(isObjectRecord(providers.microsoft) ? providers.microsoft : {}),
    };
  } else {
    const providerScoped = providers[provider];
    if (isObjectRecord(providerScoped)) {
      record = providerScoped;
    }
  }
  const sanitizedBaseUrl = sanitizeBaseUrlForStatus(record.baseUrl);
  const customBaseUrl =
    provider === "openai" &&
    (sanitizedBaseUrl
      ? sanitizedBaseUrl.replace(/\/+$/, "") !== DEFAULT_OPENAI_TTS_BASE_URL
      : false);
  const details: Partial<TtsStatusSnapshot> = {};
  for (const [field, keys] of [
    ["displayName", ["displayName"]],
    ["model", ["model", "modelId"]],
    ["voice", ["speakerVoice", "speakerVoiceId", "voice", "voiceId", "voiceName"]],
  ] as const) {
    let value: string | undefined;
    for (const key of keys) {
      value = normalizeStatusDetail(record[key]);
      if (value) {
        break;
      }
    }
    if (value) {
      details[field] = value;
    }
  }
  if (sanitizedBaseUrl && (provider !== "openai" || customBaseUrl)) {
    details.baseUrl = sanitizedBaseUrl;
    details.customBaseUrl = customBaseUrl;
  }
  return details;
}

export function resolveStatusTtsSnapshot(params: {
  cfg: OpenClawConfig;
  preparedTtsPreferences?: PreparedTtsPreferences;
  sessionAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): TtsStatusSnapshot | null {
  const settings = resolveTtsSettingsSnapshot(params);
  if (settings.autoMode === "off") {
    return null;
  }
  const provider = settings.preferredProvider ?? "auto";

  return {
    autoMode: settings.autoMode,
    provider,
    ...resolveStatusProviderDetails(settings.config.rawConfig ?? {}, provider),
    ...(settings.personaId ? { persona: settings.personaId } : {}),
    maxLength: settings.maxLength,
    summarize: settings.summarize,
  };
}
