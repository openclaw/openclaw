import { ensureRecord, getRecord, type LegacyConfigMigration } from "./legacy.shared.js";

export const LEGACY_CONFIG_MIGRATIONS_PART_4: LegacyConfigMigration[] = [
  {
    id: "tools.web.search.apiKey->brave.apiKey",
    describe: "Move tools.web.search.apiKey to tools.web.search.brave.apiKey",
    apply: (raw, changes) => {
      const tools = getRecord(raw.tools);
      const web = getRecord(tools?.web);
      const search = getRecord(web?.search);
      if (!search || typeof search.apiKey !== "string") {
        return;
      }
      const brave = ensureRecord(search, "brave");
      if (brave.apiKey === undefined) {
        brave.apiKey = search.apiKey;
        changes.push("Moved tools.web.search.apiKey → tools.web.search.brave.apiKey.");
      }
      delete search.apiKey;
    },
  },
];
