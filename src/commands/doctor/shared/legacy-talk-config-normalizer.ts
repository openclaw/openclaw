// Legacy Talk config normalizer for provider scalar fields and realtime aliases.
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTalkSection } from "../../../config/talk.js";
import type { OpenClawConfig } from "../../../config/types.js";

function buildLegacyTalkProviderCompat(
  talk: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const compat: Record<string, unknown> = {};
  for (const key of ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"] as const) {
    if (talk[key] !== undefined) {
      compat[key] = talk[key];
    }
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function buildLegacyRealtimeTalkCompat(
  talk: Record<string, unknown>,
  normalizedTalk: NonNullable<OpenClawConfig["talk"]>,
): Record<string, unknown> | undefined {
  if (talk.realtime !== undefined) {
    return undefined;
  }
  const compat: Record<string, unknown> = {};
  for (const key of ["model", "voice", "mode", "transport", "brain"] as const) {
    if (talk[key] !== undefined) {
      compat[key] = talk[key];
    }
  }
  if (Object.keys(compat).length === 0) {
    return undefined;
  }
  // When migrating legacy flat voice field into realtime block,
  // also seed speakerVoice so the realtime canonical form is complete.
  if (compat.voice !== undefined && compat.speakerVoice === undefined) {
    compat.speakerVoice = compat.voice;
  }
  if (normalizedTalk.provider !== undefined) {
    compat.provider = normalizedTalk.provider;
  }
  if (normalizedTalk.providers !== undefined) {
    compat.providers = normalizedTalk.providers;
  }
  return normalizeTalkSection({ realtime: compat } as OpenClawConfig["talk"])?.realtime;
}

/**
 * Produce a stable JSON representation with sorted keys.
 * Used as secondary comparison to prevent spurious normalization
 * when isDeepStrictEqual detects a difference that disappears after
 * JSON round-trip (e.g. derived field defaults like speakerVoice).
 */
function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, function replacer(_key, val) {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      if (seen.has(val as object)) {
        return val;
      }
      seen.add(val as object);
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).toSorted()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

/** Normalize legacy Talk provider/realtime fields into current talk.providers and talk.realtime. */
export function normalizeLegacyTalkConfig(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const rawTalk = cfg.talk;
  if (!isRecord(rawTalk)) {
    return cfg;
  }

  const normalizedTalk = normalizeTalkSection(rawTalk as OpenClawConfig["talk"]) ?? {};
  const legacyProviderCompat = buildLegacyTalkProviderCompat(rawTalk);
  if (legacyProviderCompat) {
    normalizedTalk.providers = {
      ...normalizedTalk.providers,
      elevenlabs: {
        ...legacyProviderCompat,
        ...normalizedTalk.providers?.elevenlabs,
      },
    };
  }
  const legacyRealtimeCompat = buildLegacyRealtimeTalkCompat(rawTalk, normalizedTalk);
  if (legacyRealtimeCompat) {
    normalizedTalk.realtime = {
      ...legacyRealtimeCompat,
      ...normalizedTalk.realtime,
    };
  }
  if (Object.keys(normalizedTalk).length === 0) {
    return cfg;
  }
  // Skip normalization when objects are identical (covers key-order differences).
  // But also guard against derived fields that differ in JS memory yet serialize
  // to the same on-disk bytes — a deep-equal difference that JSON round-trips away
  // would still cause repeat doctor suggestions (#90446).
  if (isDeepStrictEqual(normalizedTalk, rawTalk)) {
    return cfg;
  }
  if (stableJson(normalizedTalk) === stableJson(rawTalk)) {
    return cfg;
  }

  changes.push(
    "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
  );
  if (legacyRealtimeCompat) {
    changes.push("Moved legacy realtime Talk provider/model fields into talk.realtime.");
  }
  return {
    ...cfg,
    talk: normalizedTalk,
  };
}
