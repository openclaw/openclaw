// Legacy web-search config migration from tools.web.search to plugin-owned config.
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebSearchConfig,
} from "./legacy-web-tools-migrate.js";

export const LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH: LegacyConfigMigrationSpec[] = [
  {
    id: "tools.web.search-provider-config->plugins.entries",
    legacyRules: [
      {
        path: ["tools", "web", "search"],
        message:
          'tools.web.search provider-owned config moved to plugins.entries.<plugin>.config.webSearch. Run "openclaw doctor --fix".',
        match: (_value, root) => listLegacyWebSearchConfigPaths(root).length > 0,
        requireSourceLiteral: true,
      },
    ],
    apply: (raw, changes) => {
      const migrated = migrateLegacyWebSearchConfig(raw);
      if (migrated.changes.length === 0) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  },
];
