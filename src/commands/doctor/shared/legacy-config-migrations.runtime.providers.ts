import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

const X_SEARCH_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "apiKey"],
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
    describe: "Move legacy x_search auth into the xAI plugin webSearch config",
    legacyRules: [X_SEARCH_RULE],
    apply: (raw, changes) => {
      const migrated = migrateLegacyXSearchConfig(raw);
      if (!migrated.changes.length) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  }),
];
