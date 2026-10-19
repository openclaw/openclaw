import { getRecord, type LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

export const LEGACY_CONFIG_MIGRATION_RUNTIME_TOOL_SEARCH: LegacyConfigMigrationSpec = {
  id: "tools.toolSearch.structured-only",
  legacyRules: [
    {
      path: ["tools", "toolSearch", "mode"],
      match: (value) => value === "code",
      message:
        'Tool Search code mode (tool_search_code) is retired; use structured Tool Search. Run "openclaw doctor --fix".',
    },
    {
      path: ["tools", "toolSearch", "codeTimeoutMs"],
      message: 'tools.toolSearch.codeTimeoutMs is retired. Run "openclaw doctor --fix".',
    },
  ],
  apply: (raw, changes) => {
    const toolSearch = getRecord(getRecord(raw.tools)?.toolSearch);
    if (!toolSearch) {
      return;
    }
    if (toolSearch.mode === "code") {
      toolSearch.mode = "tools";
      changes.push(
        "Tool Search code mode (tool_search_code) is retired; using structured Tool Search.",
      );
    }
    if (Object.hasOwn(toolSearch, "codeTimeoutMs")) {
      delete toolSearch.codeTimeoutMs;
      // A timeout-only object previously enabled Tool Search through its authored options.
      if (
        typeof toolSearch.enabled !== "boolean" &&
        !Object.keys(toolSearch).some((key) => key !== "enabled")
      ) {
        toolSearch.enabled = true;
      }
      changes.push("Removed tools.toolSearch.codeTimeoutMs; Tool Search no longer executes code.");
    }
  },
};
