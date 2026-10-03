// Core doctor compatibility migration pipeline for current config objects.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAgentRosterProperty } from "../../../agents/agent-scope-config.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { migrateLegacyCommandOwners } from "../../doctor-command-owner.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import type { LegacyCodexModelIdentity } from "./codex-route-model-ref.js";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";
import { normalizeBaseCompatibilityConfigValues } from "./legacy-config-compatibility-base.js";
import { normalizeLegacyOpenAICodexModelsAddMetadata } from "./legacy-config-core-normalizers.js";
import { stripRetiredTuningKnobs } from "./legacy-config-migrations.runtime.retired-media.js";
import { migrateLegacySecretInputs } from "./legacy-secret-inputs.js";
import { migrateReservedMcpServerNames } from "./reserved-mcp-server-name-migrate.js";

function repairAgentRoster(
  cfg: OpenClawConfig,
  repair: (agent: Record<string, unknown>, path: string) => Record<string, unknown>,
): OpenClawConfig {
  // Snapshot/legacy migration normally converts lists first; blocked include migrations
  // can still leave a legacy list in doctor's best-effort candidate.
  const roster = readAgentRosterProperty(cfg);
  const values = roster?.value;
  if (!roster || (!isRecord(values) && !Array.isArray(values))) {
    return cfg;
  }
  if (Array.isArray(values) !== (roster.kind === "list")) {
    return cfg;
  }
  let changed = false;
  const entries = Object.entries(values).map(([key, agent]) => {
    const path = roster.kind === "entries" ? `agents.entries.${key}` : `agents.list[${key}]`;
    const next = isRecord(agent) ? repair(agent, path) : agent;
    changed ||= next !== agent;
    return [key, next] as const;
  });
  return changed
    ? {
        ...cfg,
        agents: {
          ...cfg.agents,
          [roster.kind]:
            roster.kind === "entries"
              ? Object.fromEntries(entries)
              : entries.map(([, agent]) => agent),
        },
      }
    : cfg;
}

function repairNullAgentWorkspaces(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  let repaired = 0;
  const next = repairAgentRoster(cfg, (agent) => {
    if (agent.workspace === null) {
      repaired += 1;
      const { workspace: _workspace, ...rest } = agent;
      return rest;
    }
    return agent;
  });

  if (repaired === 0) {
    return cfg;
  }

  changes.push(
    `Removed null workspace value${repaired === 1 ? "" : "s"} from agents.${readAgentRosterProperty(cfg)?.kind} entr${
      repaired === 1 ? "y" : "ies"
    }.`,
  );
  return next;
}

/** Normalize pre-admission config through core, plugin setup, channel, and secret-ref migrations. */
export function normalizeCompatibilityConfigValues(
  raw: unknown,
  options: {
    blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
    sourceRaw?: unknown;
  } = {},
): {
  config: OpenClawConfigWithLegacyRoster;
  changes: string[];
  warnings?: string[];
} {
  if (!isRecord(raw)) {
    throw new TypeError("Compatibility config normalization requires an object");
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  const reservedMcpServerNames = migrateReservedMcpServerNames(raw, options.sourceRaw);
  changes.push(...reservedMcpServerNames.changes);
  let next = normalizeBaseCompatibilityConfigValues(
    reservedMcpServerNames.config,
    changes,
    (config) => {
      const setupMigration = runPluginSetupConfigMigrations({
        config,
      });
      warnings.push(...(setupMigration.warnings ?? []));
      changes.push(...setupMigration.changes);
      return setupMigration.config;
    },
    options.blockedModelIdentities,
  );
  const tuningCandidate = structuredClone(next);
  if (stripRetiredTuningKnobs(tuningCandidate, changes)) {
    next = tuningCandidate;
  }
  const channelMigrations = applyChannelDoctorCompatibilityMigrations(next, {
    historicalWebhookListeners: true,
  });
  warnings.push(...(channelMigrations.warnings ?? []));
  if (channelMigrations.changes.length > 0) {
    next = channelMigrations.next;
    changes.push(...channelMigrations.changes);
  }
  const secretRefMarkers = migrateLegacySecretInputs(next);
  if (secretRefMarkers.changes.length > 0) {
    next = secretRefMarkers.config;
    changes.push(...secretRefMarkers.changes);
  }
  next = normalizeLegacyOpenAICodexModelsAddMetadata(next, changes);
  next = repairNullAgentWorkspaces(next, changes);
  next = migrateLegacyCommandOwners(next, changes);
  next = pruneBindingsForMissingAgents(next, changes);

  return {
    config: next,
    changes,
    ...(warnings.length ? { warnings } : {}),
  };
}
