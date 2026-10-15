// Core doctor compatibility migration pipeline for current config objects.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAgentRosterProperty } from "../../../agents/agent-scope-config.js";
import { inheritLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import { copyConfigResolutionFactsThroughRewrite } from "../../../config/resolution-facts.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runPluginSetupConfigMigrations } from "../../../plugins/setup-registry.js";
import { migrateLegacyCommandOwners } from "../../doctor-command-owner.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import type { LegacyCodexModelIdentity } from "./codex-route-model-ref.js";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";
import {
  normalizeLegacyMistralModelDefaults,
  normalizeLegacyNanoBananaSkill,
  normalizeLegacyOllamaNativeNumCtxParams,
  normalizeLegacyOpenAICodexModelsAddMetadata,
  normalizeLegacyOpenAIModelProviderApi,
  normalizeLegacyRuntimeModelRefs,
  normalizeLegacyTalkConfig,
  seedMissingDefaultAccountsFromSingleAccountBase,
} from "./legacy-config-core-normalizers.js";
import { stripRetiredTuningKnobs } from "./legacy-config-migrations.runtime.retired-media.js";
import { migrateLegacySecretInputs } from "./legacy-secret-inputs.js";
import {
  migrateLegacyWebFetchConfig,
  migrateLegacyWebSearchConfig,
  migrateLegacyXSearchConfig,
} from "./legacy-web-tools-migrate.js";
import { migrateReservedMcpServerNames } from "./reserved-mcp-server-name-migrate.js";

function repairAgentRoster(
  cfg: OpenClawConfig,
  repair: (agent: Record<string, unknown>, path: string) => void,
): void {
  // Blocked include migrations can still leave a legacy list in the candidate.
  const roster = readAgentRosterProperty(cfg);
  const values = roster?.value;
  if (
    !roster ||
    (!isRecord(values) && !Array.isArray(values)) ||
    Array.isArray(values) !== (roster.kind === "list")
  ) {
    return;
  }
  for (const [key, agent] of Object.entries(values)) {
    if (isRecord(agent)) {
      repair(agent, roster.kind === "entries" ? `agents.entries.${key}` : `agents.list[${key}]`);
    }
  }
}

function repairNullAgentWorkspaces(cfg: OpenClawConfig, changes: string[]): void {
  let repaired = 0;
  repairAgentRoster(cfg, (agent) => {
    if (agent.workspace === null) {
      repaired += 1;
      delete agent.workspace;
    }
  });
  if (repaired) {
    changes.push(
      `Removed null workspace value${repaired === 1 ? "" : "s"} from agents.${readAgentRosterProperty(cfg)?.kind} entr${
        repaired === 1 ? "y" : "ies"
      }.`,
    );
  }
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
  const reserved = migrateReservedMcpServerNames(raw, options.sourceRaw);
  changes.push(...reserved.changes);
  // Account promotion creates the private candidate used by the mutable core passes.
  let next = seedMissingDefaultAccountsFromSingleAccountBase(reserved.config, changes);
  const setup = runPluginSetupConfigMigrations({ config: next });
  next = setup.config;
  changes.push(...setup.changes);
  warnings.push(...(setup.warnings ?? []));
  for (const migrate of [
    migrateLegacyWebSearchConfig,
    migrateLegacyWebFetchConfig,
    migrateLegacyXSearchConfig,
  ]) {
    const migrated = migrate(next);
    if (migrated.changes.length) {
      next = migrated.config;
      changes.push(...migrated.changes);
    }
  }
  normalizeLegacyNanoBananaSkill(next, changes);
  next = normalizeLegacyTalkConfig(next, changes);
  normalizeLegacyOpenAIModelProviderApi(next, changes);
  next = normalizeLegacyRuntimeModelRefs(next, changes, options.blockedModelIdentities);
  normalizeLegacyOllamaNativeNumCtxParams(next, changes);
  normalizeLegacyMistralModelDefaults(next, changes);
  stripRetiredTuningKnobs(next, changes);
  const channels = applyChannelDoctorCompatibilityMigrations(next, {
    historicalWebhookListeners: true,
  });
  warnings.push(...(channels.warnings ?? []));
  if (channels.changes.length) {
    next = channels.next;
    changes.push(...channels.changes);
  }
  const secrets = migrateLegacySecretInputs(next);
  if (secrets.changes.length) {
    next = secrets.config;
    changes.push(...secrets.changes);
  }
  normalizeLegacyOpenAICodexModelsAddMetadata(next, changes);
  repairNullAgentWorkspaces(next, changes);
  next = migrateLegacyCommandOwners(next, changes);
  next = pruneBindingsForMissingAgents(next, changes);
  copyConfigResolutionFactsThroughRewrite(raw, next);
  return {
    config: inheritLegacyDefaultAgentId(raw, next),
    changes,
    ...(warnings.length ? { warnings } : {}),
  };
}
