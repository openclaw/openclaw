import { isDeepStrictEqual } from "node:util";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { normalizeTalkRealtimeConfig, normalizeTalkSection } from "../../../config/talk.js";
import type { OpenClawConfig } from "../../../config/types.js";

/** Preserve flat speech fields for their plugin-owned migration. */
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
  if (Object.keys(normalizedTalk).length === 0 || isDeepStrictEqual(normalizedTalk, rawTalk)) {
    return cfg;
  }

  changes.push(
    "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
  );
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

export const LEGACY_TALK_VOICE_CALL_INHERITANCE: LegacyConfigMigrationSpec = {
  id: "talk.voice-call-realtime-inheritance",
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
};
