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
 * Check whether normalized and raw talk configs differ only in speakerVoice
 * derived from voice. normalizeTalkRealtimeConfig intentionally derives
 * speakerVoice from voice (gateway talk.config response compatibility),
 * but the doctor should not report this as a config change (#90446).
 */
function equivalentTalkConfig(
  normalized: Record<string, unknown>,
  raw: Record<string, unknown>,
): boolean {
  // Fast path: deep equal already failed. Check if the only difference is
  // a derived speakerVoice field.
  const stripped = structuredClone(normalized);
  const nRt = stripped.realtime as Record<string, unknown> | undefined;
  const rRt = raw.realtime as Record<string, unknown> | undefined;
  if (nRt && rRt && typeof nRt.speakerVoice === "string" && nRt.speakerVoice === nRt.voice) {
    // speakerVoice was derived from voice — only strip when raw doesn't have it
    if (!("speakerVoice" in rRt)) {
      delete nRt.speakerVoice;
      if (isDeepStrictEqual(stripped, raw)) {
        return true;
      }
    }
  }
  return false;
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
  // Skip normalization when objects are identical.
  // Also skip when the only difference is speakerVoice derived from voice
  // by normalizeTalkRealtimeConfig (gateway response compatibility requires
  // the derivation, but doctor should not treat it as a config change — #90446).
  if (isDeepStrictEqual(normalizedTalk, rawTalk)) {
    return cfg;
  }
  if (
    equivalentTalkConfig(
      normalizedTalk as Record<string, unknown>,
      rawTalk as Record<string, unknown>,
    )
  ) {
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
