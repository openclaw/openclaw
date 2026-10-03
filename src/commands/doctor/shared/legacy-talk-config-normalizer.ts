// Legacy Talk config normalizer for provider shape and generic realtime aliases.
import { isDeepStrictEqual } from "node:util";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { defineLegacyConfigMigration, getRecord } from "../../../config/legacy.shared.js";
import { normalizeTalkRealtimeConfig, normalizeTalkSection } from "../../../config/talk.js";
import type { OpenClawConfig } from "../../../config/types.js";

function buildLegacyRealtimeTalkCompat(
  talk: Record<string, unknown>,
  normalizedTalk: NonNullable<OpenClawConfig["talk"]>,
): NonNullable<OpenClawConfig["talk"]>["realtime"] {
  if (talk.realtime !== undefined) {
    return undefined;
  }
  const compat: Record<string, unknown> = {};
  for (const key of ["model", "mode", "transport", "brain"] as const) {
    if (talk[key] !== undefined) {
      compat[key] = talk[key];
    }
  }
  if (talk.voice !== undefined) {
    compat.speakerVoice = talk.voice;
  }
  if (Object.keys(compat).length === 0) {
    return undefined;
  }
  if (normalizedTalk.provider !== undefined) {
    compat.provider = normalizedTalk.provider;
  }
  if (normalizedTalk.providers !== undefined) {
    compat.providers = normalizedTalk.providers;
  }
  return normalizeTalkSection({ realtime: compat } as OpenClawConfig["talk"])?.realtime;
}

/** Normalize Talk provider shape and move only core-owned legacy realtime fields. */
export function normalizeLegacyTalkConfig(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const rawTalk: unknown = cfg.talk;
  if (!isRecord(rawTalk)) {
    return cfg;
  }

  const normalizedTalk: Record<string, unknown> & NonNullable<OpenClawConfig["talk"]> =
    normalizeTalkSection(rawTalk as OpenClawConfig["talk"]) ?? {};
  for (const key of ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"] as const) {
    if (rawTalk[key] !== undefined) {
      normalizedTalk[key] = rawTalk[key];
    }
  }
  const legacyRealtimeCompat = buildLegacyRealtimeTalkCompat(rawTalk, normalizedTalk);
  if (legacyRealtimeCompat) {
    normalizedTalk.realtime = legacyRealtimeCompat;
  }
  if (Object.keys(normalizedTalk).length === 0 || isDeepStrictEqual(normalizedTalk, rawTalk)) {
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

function prepareVoiceCallTalkInheritance(raw: Record<string, unknown>) {
  const entries = getRecord(getRecord(raw.plugins)?.entries);
  const voiceCall = getRecord(getRecord(entries?.["voice-call"])?.config);
  const source = getRecord(voiceCall?.realtime);
  if (!source || (raw.talk !== undefined && !isRecord(raw.talk))) {
    return undefined;
  }
  const inherited = normalizeTalkRealtimeConfig({
    provider: source.provider,
    providers: source.providers,
  });
  if (!inherited) {
    return undefined;
  }
  const changes: string[] = [];
  const normalized = normalizeLegacyTalkConfig(raw, changes);
  const current = normalized.talk?.realtime;
  const currentProviders = Object.keys(current?.providers ?? {});
  const providers = { ...current?.providers };
  for (const [id, config] of Object.entries(inherited.providers ?? {})) {
    if (findNormalizedProviderKey(providers, id) === undefined) {
      providers[id] = config;
    }
  }
  const providerIds = Object.keys(providers);
  // Preserve a sole Talk provider before adding independently configured telephony providers.
  const provider =
    current?.provider ??
    (currentProviders.length === 1 ? currentProviders[0] : inherited.provider) ??
    (providerIds.length === 1 ? providerIds[0] : undefined);
  const realtime = {
    ...current,
    ...(provider ? { provider } : {}),
    ...(providerIds.length > 0 ? { providers } : {}),
  };
  if (isDeepStrictEqual(current, realtime)) {
    return undefined;
  }
  return {
    talk: { ...normalized.talk, realtime },
    changes: [
      ...changes,
      "Copied inherited Voice Call realtime settings into talk.realtime; explicit Talk settings were preserved.",
    ],
  };
}

export const LEGACY_TALK_VOICE_CALL_INHERITANCE = defineLegacyConfigMigration({
  id: "talk.voice-call-realtime-inheritance",
  describe: "Persist inherited Voice Call realtime settings under Talk",
  legacyRules: [
    {
      path: ["plugins", "entries", "voice-call", "config", "realtime"],
      message: "Inherited Talk realtime settings must be persisted under talk.realtime.",
      match: (_value, raw) => prepareVoiceCallTalkInheritance(raw) !== undefined,
    },
  ],
  apply: (raw, changes) => {
    const prepared = prepareVoiceCallTalkInheritance(raw);
    if (prepared) {
      raw.talk = prepared.talk;
      changes.push(...prepared.changes);
    }
  },
});
