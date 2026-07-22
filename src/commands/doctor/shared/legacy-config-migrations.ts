// Top-level legacy config migration registry and rule inventory used by doctor.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_AUDIO } from "./legacy-config-migrations.audio.js";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";
import { LEGACY_CONFIG_MIGRATIONS_QUEUE } from "./legacy-config-migrations.queue.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";
import { LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH } from "./legacy-config-migrations.web-search.js";

const LEGACY_PLUGIN_MEMORY_SLOT_RULES: LegacyConfigRule[] = [
  {
    path: ["plugins", "slots", "memory"],
    message:
      'plugins.slots.memory is legacy and is ignored by runtime routing; run "openclaw doctor --fix" to migrate it to plugins.slots["memory.recall"] and remove plugins.slots.memory.',
    match: (_value, root) => Boolean(getRecord(getRecord(root.plugins)?.slots)),
    requireSourceLiteral: true,
  },
];

const LEGACY_PLUGIN_MEMORY_SLOT_MIGRATIONS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "plugins.slots.memory->plugins.slots.memory.recall",
    describe: "Move legacy plugins.slots.memory to canonical plugins.slots.memory.recall",
    legacyRules: LEGACY_PLUGIN_MEMORY_SLOT_RULES,
    apply: (raw, changes) => {
      const plugins = getRecord(raw.plugins);
      const slots = getRecord(plugins?.slots);
      if (!slots || !Object.hasOwn(slots, "memory")) {
        return;
      }
      const hasCanonicalRecall = Object.hasOwn(slots, "memory.recall");
      const legacyValue = slots.memory;
      if (!hasCanonicalRecall && typeof legacyValue === "string" && legacyValue.trim().length > 0) {
        slots["memory.recall"] = legacyValue;
        changes.push('Moved plugins.slots.memory → plugins.slots["memory.recall"].');
      } else if (hasCanonicalRecall) {
        changes.push(
          'Removed plugins.slots.memory; plugins.slots["memory.recall"] is already set.',
        );
      } else {
        changes.push("Removed plugins.slots.memory.");
      }
      delete slots.memory;
    },
  }),
];

const LEGACY_CONFIG_MIGRATION_SPECS = [
  ...LEGACY_PLUGIN_MEMORY_SLOT_MIGRATIONS,
  ...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
  ...LEGACY_CONFIG_MIGRATIONS_AUDIO,
  ...LEGACY_CONFIG_MIGRATIONS_QUEUE,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
  ...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH,
];

/** Ordered legacy migrations without their preview-only rule metadata. */
export const LEGACY_CONFIG_MIGRATIONS = LEGACY_CONFIG_MIGRATION_SPECS.map(
  ({ legacyRules: _legacyRules, ...migration }) => migration,
);

/** Aggregated legacy config rules used for doctor preview issue detection. */
export const LEGACY_CONFIG_MIGRATION_RULES = LEGACY_CONFIG_MIGRATION_SPECS.flatMap(
  (migration) => migration.legacyRules ?? [],
);
