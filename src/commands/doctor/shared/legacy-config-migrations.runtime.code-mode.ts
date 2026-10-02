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

export const LEGACY_CONFIG_MIGRATION_RUNTIME_CODE_MODE_EXECUTOR = defineLegacyConfigMigration({
  id: "tools.codeMode.executor",
  describe: "Move the explicit Code Mode runtime to its executor setting",
  legacyRules: [
    {
      path: ["tools", "codeMode", "runtime"],
      message:
        'tools.codeMode.runtime moved to tools.codeMode.executor. Run "openclaw doctor --fix".',
    },
    {
      path: ["agents"],
      message:
        'Per-agent tools.codeMode.runtime moved to tools.codeMode.executor. Run "openclaw doctor --fix".',
      match: (value) => {
        let found = false;
        visitAgentEntries({ agents: value }, (agent) => {
          found ||= Object.hasOwn(getRecord(getRecord(agent.tools)?.codeMode) ?? {}, "runtime");
        });
        return found;
      },
    },
  ],
  apply: (raw, changes) => {
    const migrateRuntime = (tools: unknown, path: string) => {
      const codeMode = getRecord(getRecord(tools)?.codeMode);
      if (codeMode?.runtime !== "quickjs-wasi") {
        return;
      }
      if (Object.hasOwn(codeMode, "executor")) {
        changes.push(`Removed ${path}.codeMode.runtime; kept explicit ${path}.codeMode.executor.`);
      } else {
        codeMode.executor = "quickjs";
        changes.push(`Moved ${path}.codeMode.runtime to ${path}.codeMode.executor (quickjs).`);
      }
      delete codeMode.runtime;
    };
    migrateRuntime(raw.tools, "tools");
    visitAgentEntries(raw, (agent, path) => migrateRuntime(agent.tools, `${path}.tools`));
  },
});
