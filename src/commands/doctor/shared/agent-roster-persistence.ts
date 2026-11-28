import { listAgentEntries } from "../../../agents/agent-scope-config.js";
import { configIncludeOwnsAgentRoster } from "../../../config/agent-roster-provenance.js";
import { findLegacyConfigRuleIssues } from "../../../config/legacy.shared.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { LEGACY_AGENT_ROSTER_RULES } from "./legacy-config-migrations.runtime.entries.js";

/**
 * Whether Doctor's config flow writes the canonical agent roster into the root config: the
 * authored roster is legacy, empty, or several agents lack an explicit ownership mode, and no
 * `$include` owns the roster.
 */
export function needsCanonicalAgentRosterPersistence(
  snapshot: ConfigFileSnapshot,
  baseConfig: OpenClawConfig,
): boolean {
  const sourceRosterConfig = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const rosterMigrationNeeded =
    findLegacyConfigRuleIssues(sourceRosterConfig, LEGACY_AGENT_ROSTER_RULES).length > 0 ||
    listAgentEntries(sourceRosterConfig).length === 0 ||
    (baseConfig.agents?.ownership === undefined && listAgentEntries(baseConfig).length > 1);
  return snapshot.exists && rosterMigrationNeeded && !configIncludeOwnsAgentRoster(snapshot);
}
