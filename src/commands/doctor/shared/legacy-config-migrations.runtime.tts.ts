import {
  defineLegacyConfigMigration,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../config/prototype-keys.js";

const LEGACY_TTS_PROVIDER_KEYS = ["openai", "elevenlabs", "microsoft", "edge"] as const;
const LEGACY_TTS_PLUGIN_IDS = new Set(["voice-call"]);

function hasLegacyTtsProviderKeys(value: unknown): boolean {
  const tts = getRecord(value);
  if (!tts) {
    return false;
  }
  return LEGACY_TTS_PROVIDER_KEYS.some((key) => Object.prototype.hasOwnProperty.call(tts, key));
}

function hasLegacyPluginEntryTtsProviderKeys(value: unknown): boolean {
  const entries = getRecord(value);
  if (!entries) {
    return false;
  }
  return Object.entries(entries).some(([pluginId, entryValue]) => {
    if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
      return false;
    }
    const entry = getRecord(entryValue);
    const config = getRecord(entry?.config);
    return hasLegacyTtsProviderKeys(config?.tts);
  });
}

function getOrCreateTtsProviders(tts: Record<string, unknown>): Record<string, unknown> {
  const providers = getRecord(tts.providers) ?? {};
  tts.providers = providers;
  return providers;
}

function mergeLegacyTtsProviderConfig(
  tts: Record<string, unknown>,
  legacyKey: string,
  providerId: string,
): boolean {
  const legacyValue = getRecord(tts[legacyKey]);
  if (!legacyValue) {
    return false;
  }
  const providers = getOrCreateTtsProviders(tts);
  const existing = getRecord(providers[providerId]) ?? {};
  const merged = structuredClone(existing);
  mergeMissing(merged, legacyValue);
  providers[providerId] = merged;
  delete tts[legacyKey];
  return true;
}

function migrateLegacyTtsConfig(
  tts: Record<string, unknown> | null | undefined,
  pathLabel: string,
  changes: string[],
): void {
  if (!tts) {
    return;
  }
  const movedOpenAI = mergeLegacyTtsProviderConfig(tts, "openai", "openai");
  const movedElevenLabs = mergeLegacyTtsProviderConfig(tts, "elevenlabs", "elevenlabs");
  const movedMicrosoft = mergeLegacyTtsProviderConfig(tts, "microsoft", "microsoft");
  const movedEdge = mergeLegacyTtsProviderConfig(tts, "edge", "microsoft");

  if (movedOpenAI) {
    changes.push(`Moved ${pathLabel}.openai → ${pathLabel}.providers.openai.`);
  }
  if (movedElevenLabs) {
    changes.push(`Moved ${pathLabel}.elevenlabs → ${pathLabel}.providers.elevenlabs.`);
  }
  if (movedMicrosoft) {
    changes.push(`Moved ${pathLabel}.microsoft → ${pathLabel}.providers.microsoft.`);
  }
  if (movedEdge) {
    changes.push(`Moved ${pathLabel}.edge → ${pathLabel}.providers.microsoft.`);
  }
}

const LEGACY_TTS_RULES: LegacyConfigRule[] = [
  {
    path: ["messages", "tts"],
    message:
      'messages.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use messages.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyTtsProviderKeys(value),
  },
  {
    path: ["plugins", "entries"],
    message:
      'plugins.entries.voice-call.config.tts.<provider> keys (openai/elevenlabs/microsoft/edge) are legacy; use plugins.entries.voice-call.config.tts.providers.<provider>. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyPluginEntryTtsProviderKeys(value),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tts.providers-generic-shape",
    describe: "Move legacy bundled TTS config keys into messages.tts.providers",
    legacyRules: LEGACY_TTS_RULES,
    apply: (raw, changes) => {
      const messages = getRecord(raw.messages);
      migrateLegacyTtsConfig(getRecord(messages?.tts), "messages.tts", changes);

      const plugins = getRecord(raw.plugins);
      const pluginEntries = getRecord(plugins?.entries);
      if (!pluginEntries) {
        return;
      }
      for (const [pluginId, entryValue] of Object.entries(pluginEntries)) {
        if (isBlockedObjectKey(pluginId) || !LEGACY_TTS_PLUGIN_IDS.has(pluginId)) {
          continue;
        }
        const entry = getRecord(entryValue);
        const config = getRecord(entry?.config);
        migrateLegacyTtsConfig(
          getRecord(config?.tts),
          `plugins.entries.${pluginId}.config.tts`,
          changes,
        );
      }
    },
  }),
];
