import { defineLegacyConfigMigration, getRecord } from "../../../config/legacy.shared.js";
import { visitAgentEntries } from "./legacy-config-record-shared.js";

export const LEGACY_CONFIG_MIGRATION_RUNTIME_CODE_MODE = defineLegacyConfigMigration({
  id: "tools.codeMode.javascript-only",
  describe: "Remove the retired Code Mode language setting",
  legacyRules: [
    {
      path: ["tools", "codeMode", "languages"],
      message:
        'tools.codeMode.languages is retired; Code Mode now runs JavaScript only. Run "openclaw doctor --fix".',
    },
    {
      path: ["agents"],
      message:
        'Per-agent tools.codeMode.languages is retired; Code Mode now runs JavaScript only. Run "openclaw doctor --fix".',
      match: (value) => {
        let found = false;
        visitAgentEntries({ agents: value }, (agent) => {
          found ||= Object.hasOwn(getRecord(getRecord(agent.tools)?.codeMode) ?? {}, "languages");
        });
        return found;
      },
    },
  ],
  apply: (raw, changes) => {
    const removeLanguages = (tools: unknown, path: string) => {
      const codeMode = getRecord(getRecord(tools)?.codeMode);
      if (!codeMode || !Object.hasOwn(codeMode, "languages")) {
        return;
      }
      delete codeMode.languages;
      changes.push(`Removed ${path}.codeMode.languages; Code Mode now runs JavaScript only.`);
    };
    removeLanguages(raw.tools, "tools");
    visitAgentEntries(raw, (agent, path) => removeLanguages(agent.tools, `${path}.tools`));
  },
});
