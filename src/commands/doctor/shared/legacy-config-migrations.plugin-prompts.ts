import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

export const LEGACY_PLUGIN_PROMPT_PERMISSION: LegacyConfigMigrationSpec = {
  id: "plugins.hooks.allowPromptModification",
  legacyRules: [
    {
      path: ["plugins", "entries"],
      match: (entries) =>
        isRecord(entries) &&
        Object.values(entries).some(
          (entry) =>
            isRecord(entry) &&
            isRecord(entry.hooks) &&
            Object.hasOwn(entry.hooks, "allowPromptInjection"),
        ),
      message:
        'plugins.entries.<id>.hooks.allowPromptInjection was renamed to allowPromptModification. Run "openclaw doctor --fix" to preserve the existing grant.',
    },
  ],
  apply: (raw, changes) => {
    const plugins = isRecord(raw.plugins) ? raw.plugins : undefined;
    if (!isRecord(plugins?.entries)) {
      return;
    }
    for (const [id, entry] of Object.entries(plugins.entries)) {
      const hooks = isRecord(entry) && isRecord(entry.hooks) ? entry.hooks : undefined;
      if (!hooks || !Object.hasOwn(hooks, "allowPromptInjection")) {
        continue;
      }
      const path = `plugins.entries.${id}.hooks`;
      const previous = hooks.allowPromptInjection;
      const current = hooks.allowPromptModification;
      if (
        typeof previous !== "boolean" ||
        (Object.hasOwn(hooks, "allowPromptModification") && current !== previous)
      ) {
        // Doctor migrates a private candidate before unknown-key removal or publication.
        // Refuse instead of dropping a denial or guessing which conflicting grant wins.
        throw new Error(
          `Cannot migrate ${path}: allowPromptInjection must be a boolean and must agree with any allowPromptModification value. Resolve the conflicting or invalid keys, then rerun "openclaw doctor --fix". The source config was not changed.`,
        );
      }
      hooks.allowPromptModification = previous;
      delete hooks.allowPromptInjection;
      changes.push(
        `Renamed ${path}.allowPromptInjection to allowPromptModification; preserved the existing grant.`,
      );
    }
  },
};
