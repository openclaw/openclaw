import {
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isBlockedObjectKey } from "../../../infra/prototype-keys.js";

const LEGACY_FLAG = "localModelLean";

function hasLegacyFlag(value: unknown): boolean {
  const experimental = getRecord(getRecord(value)?.experimental);
  return experimental ? Object.hasOwn(experimental, LEGACY_FLAG) : false;
}

// The agent entry schema no longer has an experimental block, so an empty one is also retired.
function hasRetiredAgentExperimental(value: unknown): boolean {
  const experimental = getRecord(getRecord(value)?.experimental);
  return experimental ? hasLegacyFlag(value) || Object.keys(experimental).length === 0 : false;
}

function hasAgentEntryLegacyFlag(value: unknown): boolean {
  const entries = getRecord(value);
  return entries
    ? Object.entries(entries).some(
        ([id, entry]) => !isBlockedObjectKey(id) && hasRetiredAgentExperimental(entry),
      )
    : false;
}

function hasAgentListLegacyFlag(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => hasRetiredAgentExperimental(entry));
}

const LEGACY_AGENT_PROFILE_RULES: LegacyConfigRule[] = [
  {
    path: ["agents", "defaults", "experimental", "localModelLean"],
    message:
      'agents.defaults.experimental.localModelLean moved to agents.defaults.agentProfileId. Run "openclaw doctor --fix".',
  },
  {
    path: ["agents", "entries"],
    message:
      'agents.entries.*.experimental.localModelLean moved to agentProfileId. Run "openclaw doctor --fix".',
    match: hasAgentEntryLegacyFlag,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].experimental.localModelLean moved to agentProfileId. Run "openclaw doctor --fix".',
    match: hasAgentListLegacyFlag,
  },
];

/**
 * Retired runtime flag. Doctor maps it to an Agent Profile and drops it:
 * true selects openclaw/small at the same scope; false is removed, except on
 * an agent under an enabled default, where it becomes openclaw/base.
 */
function migrateLegacyFlag(
  agent: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
  options: { defaultEnabled: boolean; removeEmpty?: boolean },
): void {
  const experimental = getRecord(agent.experimental);
  if (experimental && options.removeEmpty && Object.keys(experimental).length === 0) {
    delete agent.experimental;
    changes.push(`Removed empty retired ${pathLabel}.experimental.`);
    return;
  }
  if (!experimental || !Object.hasOwn(experimental, LEGACY_FLAG)) {
    return;
  }
  const enabled = experimental[LEGACY_FLAG] === true;
  const profileId = enabled
    ? "openclaw/small"
    : options.defaultEnabled
      ? "openclaw/base"
      : undefined;
  if (agent.agentProfileId !== undefined) {
    changes.push(
      `Removed ${pathLabel}.experimental.${LEGACY_FLAG}; kept the explicit Agent Profile.`,
    );
  } else if (profileId) {
    agent.agentProfileId = profileId;
    changes.push(`Moved ${pathLabel}.experimental.${LEGACY_FLAG} → ${pathLabel}.agentProfileId.`);
  } else {
    changes.push(
      `Removed ${pathLabel}.experimental.${LEGACY_FLAG}; the full tool surface is the default.`,
    );
  }
  delete experimental[LEGACY_FLAG];
  if (Object.keys(experimental).length === 0) {
    delete agent.experimental;
  }
}

function migrateLegacyAgentProfiles(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  if (agents) {
    const defaults = getRecord(agents.defaults);
    const defaultEnabled = getRecord(defaults?.experimental)?.[LEGACY_FLAG] === true;
    if (defaults) {
      migrateLegacyFlag(defaults, "agents.defaults", changes, { defaultEnabled: false });
    }
    const entries = getRecord(agents.entries);
    if (entries) {
      for (const [id, entry] of Object.entries(entries)) {
        if (isBlockedObjectKey(id)) {
          continue;
        }
        const agent = getRecord(entry);
        if (agent) {
          migrateLegacyFlag(agent, `agents.entries.${id}`, changes, {
            defaultEnabled,
            removeEmpty: true,
          });
        }
      }
    }
    if (Array.isArray(agents.list)) {
      for (const [index, entry] of agents.list.entries()) {
        const agent = getRecord(entry);
        if (agent) {
          migrateLegacyFlag(agent, `agents.list[${index}]`, changes, {
            defaultEnabled,
            removeEmpty: true,
          });
        }
      }
    }
  }
}

export const LEGACY_CONFIG_MIGRATIONS_AGENT_PROFILES: LegacyConfigMigrationSpec[] = [
  {
    id: "agents.localModelLean->agentProfileId",
    legacyRules: LEGACY_AGENT_PROFILE_RULES,
    apply: migrateLegacyAgentProfiles,
  },
];
