import { applyBlankAgentWorkspaceRemoval } from "../../../config/legacy.blank-agent-workspace.js";
// Legacy migration: remove explicitly blank agent workspace values.
//
// Releases before strict blank rejection (PR 150929) treated an empty or
// whitespace-only agents.defaults.workspace / agents.entries.*.workspace as
// "use the default workspace directory" (the resolver trimmed and fell back).
// Onboarding could persist such blanks, so after strict rejection an unchanged
// upgrade would make those agents fail. Doctor removes the blank key so the
// config keeps resolving to the same established default workspace directory
// without moving any files; only new blank input is rejected.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isRecord } from "./legacy-config-record-shared.js";

const BLANK_WORKSPACE_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "workspace"],
    message:
      'agents.defaults.workspace is blank; it will be removed to keep the default workspace directory. Run "openclaw doctor --fix".',
    match: (value) => typeof value === "string" && !value.trim(),
  },
  {
    path: ["agents"],
    message:
      'blank agents.entries.*.workspace values will be removed to keep each agent\'s default workspace directory. Run "openclaw doctor --fix".',
    match: (value) => {
      if (!isRecord(value)) {
        return false;
      }
      // The rule receives the whole `agents` object; the keyed entries map (and
      // the legacy list form) hold the per-agent workspace values.
      const entries = isRecord(value.entries) ? Object.values(value.entries) : [];
      const list = Array.isArray(value.list) ? value.list : [];
      return [...entries, ...list].some(
        (entry) =>
          isRecord(entry) && typeof entry.workspace === "string" && !entry.workspace.trim(),
      );
    },
  },
];

/** Strip blank agent workspace values, preserving the established default directory. */
export const LEGACY_CONFIG_MIGRATION_RUNTIME_WORKSPACE: LegacyConfigMigrationSpec =
  defineLegacyConfigMigration({
    id: "strip-blank-agent-workspaces",
    describe:
      "Removes explicitly blank agent workspace values so upgrades keep each agent's established default workspace directory.",
    legacyRules: BLANK_WORKSPACE_RULES,
    apply(raw, changes) {
      // Delegate to the shared blank-workspace transform so Doctor repair uses
      // exactly the same traversal as the load/write migration (defaults, keyed
      // entries, and the legacy list form) and can never disagree with runtime.
      applyBlankAgentWorkspaceRemoval(raw, changes);
    },
  });
