import { applyImplicitAgentRosterDefaults } from "../../../config/implicit-agent-roster.js";
import { retainLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import {
  materializeLegacyDefaultAgentRoles,
  resolveLegacyFirstAgentWorkspacePin,
} from "../../../config/legacy.default-agent-roles.js";
import { projectLegacyAgentRosterEntries } from "../../../config/legacy.roster.js";
import {
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigMigrationContext,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { copyConfigResolutionFacts } from "../../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

function migrateAgentEntries(
  raw: Record<string, unknown>,
  changes: string[],
  context?: LegacyConfigMigrationContext,
): void {
  const agents = getRecord(raw.agents);
  if (
    !agents ||
    !Object.prototype.propertyIsEnumerable.call(agents, "list") ||
    !Array.isArray(agents.list)
  ) {
    return;
  }
  if (Object.hasOwn(agents, "entries")) {
    if (getRecord(agents.entries)) {
      delete agents.list;
      changes.push("Removed agents.list because agents.entries is already set.");
    }
    return;
  }
  const projected = projectLegacyAgentRosterEntries(agents.list);
  changes.push(...projected.diagnostics);
  const orderedEntries = projected.entries.map(({ config }) => config);
  const workspace = resolveLegacyFirstAgentWorkspacePin(agents, orderedEntries, context);
  if (workspace !== undefined) {
    orderedEntries[0]!.workspace = workspace;
  }
  agents.entries = Object.fromEntries(projected.entries.map(({ id, config }) => [id, config]));
  delete agents.list;
  Object.assign(raw, applyImplicitAgentRosterDefaults(raw));
  changes.push("Moved agents.list → keyed agents.entries.");
}

/** Writers preserve existing responsibilities; Doctor uses the retired marker's original owner. */
export function retireLegacyAgentDefaultMarkers<T extends object>(raw: T) {
  const agents = getRecord(getRecord(raw)?.agents);
  const entries = getRecord(agents?.entries);
  if (!agents || !entries) {
    return undefined;
  }
  const roster: [string, Record<string, unknown>][] = [];
  for (const [id, value] of Object.entries(entries)) {
    const entry = getRecord(value);
    if (!entry || (Object.hasOwn(entry, "default") && typeof entry.default !== "boolean")) {
      return undefined;
    }
    roster.push([id, entry]);
  }
  const marked = roster.filter(([, entry]) => entry.default === true);
  if (marked.length > 1 || (marked.length > 0 && agents.ownership === "explicit")) {
    return undefined;
  }
  const changes: string[] = [];
  const canonicalEntries = Object.fromEntries(
    roster.map(([id, entry]): [string, Record<string, unknown>] => {
      if (!Object.hasOwn(entry, "default")) {
        return [id, entry];
      }
      const { default: _marker, ...canonical } = entry;
      changes.push("Removed retired agents.entries default marker.");
      return [id, canonical];
    }),
  );
  const config =
    changes.length > 0 ? { ...raw, agents: { ...agents, entries: canonicalEntries } } : raw;
  copyConfigResolutionFacts(raw, config);
  return {
    config,
    changes,
    agentCount: roster.length,
    legacyOwner: roster.length > 1 ? marked[0]?.[0] : undefined,
  };
}

export const LEGACY_AGENT_ROSTER_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "list"],
    match: (_value, root) =>
      Object.prototype.propertyIsEnumerable.call(getRecord(root.agents), "list"),
    message: 'agents.list moved to keyed agents.entries. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "entries"],
    match: (value) =>
      Object.values(getRecord(value) ?? {}).some((entry) => {
        const record = getRecord(entry);
        return record !== null && typeof record.default === "boolean";
      }),
    message:
      'Legacy agents.entries default markers need explicit surface owners. Run "openclaw doctor --fix".',
  },
];

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES: LegacyConfigMigrationSpec[] = [
  {
    id: "runtime.agents-entries",
    legacyRules: LEGACY_AGENT_ROSTER_RULES,
    apply: migrateAgentEntries,
  },
  {
    id: "runtime.agents-explicit-ownership",
    apply: (raw, changes, context) => {
      const retired = retireLegacyAgentDefaultMarkers(raw);
      if (!retired) {
        return;
      }
      Object.assign(raw, retired.config);
      const { legacyOwner } = retired;
      if (legacyOwner) {
        const materialized = materializeLegacyDefaultAgentRoles(
          // SAFETY: Roster entries are records; the helper guards raw sections until later validation.
          raw as OpenClawConfig,
          legacyOwner,
          { ...context, materializeWorkspace: true },
        );
        Object.assign(raw, materialized.config);
        retainLegacyDefaultAgentId(raw, legacyOwner);
        changes.push("Preserved legacy per-surface agent ownership and workspace.");
      }
      const nextAgents = getRecord(raw.agents)!;
      changes.push(...retired.changes);
      if (retired.agentCount < 2 || nextAgents.ownership !== undefined) {
        return;
      }
      // Recovery validates the registry's candidate before the later Doctor config flow.
      nextAgents.ownership = "explicit";
      changes.push("Stamped the multi-agent roster for explicit per-surface ownership.");
    },
  },
];
