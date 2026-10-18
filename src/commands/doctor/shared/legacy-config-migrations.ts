import type { LegacyConfigMigrationSpec, LegacyConfigRule } from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_AUDIO } from "./legacy-config-migrations.audio.js";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";
import { LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH } from "./legacy-config-migrations.web-search.js";
import { hasLegacyContextBudgetConfig } from "./legacy-context-budget.js";
import { removeLegacyCopilotDiscovery } from "./legacy-copilot-discovery.js";
import { LEGACY_CONFIG_MIGRATION_TOOLS_BY_SENDER } from "./legacy-tools-by-sender.js";

export const LEGACY_CONFIG_MIGRATIONS: LegacyConfigMigrationSpec[] = [
  ...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
  ...LEGACY_CONFIG_MIGRATIONS_QQBOT,
  ...LEGACY_CONFIG_MIGRATIONS_AUDIO,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
  ...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH,
  LEGACY_CONFIG_MIGRATION_TOOLS_BY_SENDER,
];

/** Aggregated legacy config rules used for doctor preview issue detection. */
export const LEGACY_CONFIG_MIGRATION_RULES: LegacyConfigRule[] = [
  ...LEGACY_CONFIG_MIGRATIONS.flatMap((migration) => migration.legacyRules ?? []),
  {
    path: [],
    message:
      'Context budgets use models.providers.<provider>.models[].contextTokens; run "openclaw doctor --fix" to migrate retired provider and agent keys.',
    match: hasLegacyContextBudgetConfig,
  },
  {
    path: ["plugins", "entries", "github-copilot", "config", "discovery"],
    message: 'The GitHub Copilot discovery switch was retired; run "openclaw doctor --fix".',
    match: (_value, root) => removeLegacyCopilotDiscovery(root) !== root,
  },
];
