import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

// Valid values from the current zod-schema.core.ts thinkingFormat union.
const VALID_THINKING_FORMATS = new Set([
  "openai",
  "openrouter",
  "deepseek",
  "qwen",
  "qwen-chat-template",
  "zai",
]);

function hasInvalidThinkingFormat(providers: unknown): boolean {
  const providersRecord = getRecord(providers);
  if (!providersRecord) {
    return false;
  }
  for (const provider of Object.values(providersRecord)) {
    const models = getRecord(provider)?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const compat = getRecord(getRecord(model)?.compat);
      if (!compat) {
        continue;
      }
      const fmt = compat.thinkingFormat;
      if (fmt !== undefined && !VALID_THINKING_FORMATS.has(fmt as string)) {
        return true;
      }
    }
  }
  return false;
}

const INVALID_THINKING_FORMAT_RULE: LegacyConfigRule = {
  path: ["models", "providers"],
  message:
    'models.providers.<id>.models[*].compat.thinkingFormat has an unrecognized value; run "openclaw doctor --fix" to remove it and restore the default.',
  match: (value) => hasInvalidThinkingFormat(value),
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "models.providers.*.models.*.compat.thinkingFormat-invalid",
    describe: "Remove unrecognized compat.thinkingFormat values from provider model entries",
    legacyRules: [INVALID_THINKING_FORMAT_RULE],
    apply: (raw, changes) => {
      const providersRecord = getRecord(getRecord(raw.models)?.providers);
      if (!providersRecord) {
        return;
      }
      for (const [providerId, provider] of Object.entries(providersRecord)) {
        const providerRecord = getRecord(provider);
        if (!providerRecord || !Array.isArray(providerRecord.models)) {
          continue;
        }
        for (const [index, model] of providerRecord.models.entries()) {
          const modelRecord = getRecord(model);
          const compat = getRecord(modelRecord?.compat);
          if (!compat) {
            continue;
          }
          const fmt = compat.thinkingFormat;
          if (fmt !== undefined && !VALID_THINKING_FORMATS.has(fmt as string)) {
            delete compat.thinkingFormat;
            changes.push(
              `Removed models.providers.${providerId}.models.${index}.compat.thinkingFormat (unrecognized value ${JSON.stringify(fmt)}; runtime default applies).`,
            );
          }
        }
      }
    },
  }),
];
