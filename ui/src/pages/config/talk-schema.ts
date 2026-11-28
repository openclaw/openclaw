import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
// Config-facts module for the curated Talk settings page. No lit imports: like
// memory-schema.ts, settings search evaluates these facts from the startup
// chunk and must not pull settings UI code in with them.
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";

/** Normalized model/voice pair from one `talk.realtime.providers.<id>` entry. */
type TalkProviderEntryValues = {
  model: string | null;
  speakerVoice: string | null;
};

export type TalkRealtimeSelection = ReturnType<typeof resolveTalkRealtimeSelection>;

/**
 * Raw talk.realtime picks plus each provider entry's fallback values. Which
 * entry is effective depends on the catalog's active provider and alias map,
 * so that resolution lives in the view (talk.ts), not here.
 */
export function resolveTalkRealtimeSelection(configObject: Record<string, unknown>) {
  const realtime = readRecord(readRecord(configObject.talk)?.realtime);
  const providerConfigs = readRecord(realtime?.providers) ?? {};
  const providerEntries: Record<string, TalkProviderEntryValues> = {};
  for (const [key, value] of Object.entries(providerConfigs)) {
    const entry = readRecord(value);
    if (!entry) {
      continue;
    }
    providerEntries[key] = {
      model: readTrimmedString(entry.model),
      // Provider-level `voice` is a provider-owned legacy alias for
      // speakerVoice (each provider normalizes it); read both for display.
      speakerVoice: readTrimmedString(entry.speakerVoice) ?? readTrimmedString(entry.voice),
    };
  }
  return {
    /** Raw configured `talk.realtime.provider`, possibly an alias. */
    provider: readTrimmedString(realtime?.provider),
    /** Top-level `talk.realtime.model` override only; provider fallback is resolved in the view. */
    model: readTrimmedString(realtime?.model),
    /** Top-level `speakerVoice` / `speakerVoiceId` override only. */
    speakerVoice:
      readTrimmedString(realtime?.speakerVoice) ?? readTrimmedString(realtime?.speakerVoiceId),
    /** Raw configured `talk.realtime.transport`. */
    transport: readTrimmedString(realtime?.transport),
    mode: readTrimmedString(realtime?.mode),
    /** Normalized configured `talk.realtime.consultRouting`. */
    consultRouting: readTrimmedString(realtime?.consultRouting)?.toLowerCase() ?? null,
    /** Per-provider fallback values keyed by the raw config map key. */
    providerEntries,
  };
}

/** Settings facts belong to the selected provider, including unlisted family models. */
export function resolveTalkModelFamilySettings(
  provider: TalkCatalogResult["realtime"]["providers"][number] | undefined,
  model: string | null,
) {
  const settings = provider?.modelFamilySettings;
  const normalized = model?.trim().toLowerCase();
  return settings &&
    (normalized === settings.family || normalized?.startsWith(`${settings.family}-`))
    ? settings
    : undefined;
}

/** An empty or unavailable transport catalog is not evidence of incompatibility. */
export function talkProviderRejectsTransport(
  transports: readonly string[] | undefined,
  transport: string,
): boolean {
  return transports !== undefined && transports.length > 0 && !transports.includes(transport);
}

/** True when the config schema declares the key path, so an older Gateway is never sent it. */
export function talkSchemaHasKey(schema: unknown, path: readonly string[]): boolean {
  let node = readRecord(schema);
  for (const key of path) {
    node = readRecord(readRecord(node?.properties)?.[key]);
    if (!node) {
      return false;
    }
  }
  return true;
}

// Keys the curated Talk controls own; the schema editor under Advanced shows the rest.
const CURATED_TALK_KEYS = [
  "agentId",
  "speechLocale",
  "consultThinkingLevel",
  "consultFastMode",
  "provider",
  "silenceTimeoutMs",
  "interruptOnSpeech",
  "transcription",
];
const CURATED_REALTIME_KEYS = [
  "mode",
  "provider",
  "model",
  "speakerVoice",
  "transport",
  "vadThreshold",
  "silenceDurationMs",
  "prefixPaddingMs",
  "reasoningEffort",
  "instructions",
  "brain",
  "consultRouting",
];

const talkSettingsSchemas = new WeakMap<object, unknown>();

function withoutKeys(properties: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !keys.includes(key)));
}

/** The `talk` schema minus every key a curated control already edits. */
export function talkSettingsSchema(schema: unknown): unknown {
  const root = readRecord(schema);
  const talk = readRecord(readRecord(root?.properties)?.talk);
  const talkProperties = readRecord(talk?.properties);
  if (!root || !talk || !talkProperties) {
    return schema;
  }
  const hit = talkSettingsSchemas.get(root);
  if (hit !== undefined) {
    return hit;
  }
  const realtime = readRecord(talkProperties.realtime);
  const realtimeProperties = readRecord(realtime?.properties);
  const narrowed = {
    ...root,
    properties: {
      talk: {
        ...talk,
        properties: {
          ...withoutKeys(talkProperties, CURATED_TALK_KEYS),
          ...(realtime && realtimeProperties
            ? {
                realtime: {
                  ...realtime,
                  properties: withoutKeys(realtimeProperties, CURATED_REALTIME_KEYS),
                },
              }
            : {}),
        },
      },
    },
  };
  talkSettingsSchemas.set(root, narrowed);
  return narrowed;
}
