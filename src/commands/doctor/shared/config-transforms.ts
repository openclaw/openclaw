import type { ConfigAuditRecord } from "../../../config/io.audit.js";
import { hashConfigRaw } from "../../../config/io.read-helpers.js";
import { applyPluginAutoEnableAsync } from "../../../config/plugin-auto-enable.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE } from "../../../plugins/official-runtime-plugins.js";
import { recoverCommandOwnerTargetKinds } from "../../doctor-command-owner-recovery.js";
import { maybeRepairGroupAllowFromFallback } from "./allowfrom-fallback-migration.js";
import { maybeRepairAllowlistPolicyAllowFrom } from "./allowlist-policy-repair.js";
import { maybeRepairBundledPluginLoadPaths } from "./bundled-plugin-load-paths.js";
import { maybeRepairCodexRoutes } from "./codex-route-warnings.js";
import { maybeRepairContextEnginePluginIdSelector } from "./context-engine-plugin-id-selector.js";
import { maybeRepairExecSafeBinProfiles } from "./exec-safe-bins.js";
import { repairHooksTokenReuseGatewayAuth } from "./hooks-token-reuse-repair.js";
import { maybeRepairInvalidPluginConfig } from "./invalid-plugin-config.js";
import { repairUnownedChannelAccountBindings } from "./legacy-config-binding-repair.js";
import { normalizeCompatibilityConfigValues } from "./legacy-config-core-migrate.js";
import type { BlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";
import { repairGeneratedModelMetadataCorruption } from "./model-metadata-corruption-repair.js";
import { maybeRepairOpenPolicyAllowFrom } from "./open-policy-allowfrom.js";
import { maybeRepairStalePluginConfig } from "./stale-plugin-config.js";
import { maybeRepairStaleSubagentAllowlists } from "./stale-subagent-allowlist.js";

/** What the config flow's transforms read beside the candidate. */
export type DoctorConfigFlowTransformContext = {
  env: NodeJS.ProcessEnv;
  snapshot: Pick<ConfigFileSnapshot, "path" | "parsed" | "raw" | "sourceConfigBeforeMigrations">;
  blockedCodexProviderPlan: BlockedLegacyOpenAICodexProviderPlan;
  loadAuditRecords: () => readonly ConfigAuditRecord[];
};

/** What the repair sequence's transforms read beside the candidate. */
export type DoctorRepairSequenceTransformContext = {
  env: NodeJS.ProcessEnv;
  blockedCodexProviderPlan?: BlockedLegacyOpenAICodexProviderPlan;
};

export type DoctorConfigTransformResult = {
  config: OpenClawConfig;
  changes: string[];
  warnings?: string[];
  /** Notes about config Doctor neither repairs nor depends on. */
  advisories?: string[];
};

type DoctorConfigTransform<Context> = (
  config: OpenClawConfig,
  context: Context,
) => DoctorConfigTransformResult | Promise<DoctorConfigTransformResult>;

// The config repair stages that change only the candidate config they are handed, keyed by the
// name Doctor's `config-flow.config-repairs.<id>` pending input traces. The config flow and its
// repair sequence run each one by id; the pending check runs the same function on a private
// copy, so a repair and its decision share one implementation.

const CONFIG_FLOW_TRANSFORMS = {
  "model-metadata": (config, { snapshot, loadAuditRecords }) =>
    repairGeneratedModelMetadataCorruption({
      config,
      authoredRoot: snapshot.parsed,
      configPath: snapshot.path,
      currentHash: hashConfigRaw(snapshot.raw),
      loadAuditRecords,
    }),
  "compatibility-values": (config, { snapshot, blockedCodexProviderPlan }) =>
    normalizeCompatibilityConfigValues(config, {
      blockedModelIdentities: new Set(blockedCodexProviderPlan.blockedModelIdentities),
      sourceRaw: snapshot.parsed,
    }),
  "command-owner-targets": (config, { snapshot }) =>
    recoverCommandOwnerTargetKinds({ config, snapshot }),
  "channel-account-bindings": (config, { snapshot }) =>
    repairUnownedChannelAccountBindings({
      config,
      sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations,
    }),
  "plugin-auto-enable": (config, { env }) => applyPluginAutoEnableAsync({ config, env }),
  "hooks-token-reuse": (config, { env }) => repairHooksTokenReuseGatewayAuth(config, env),
} satisfies Record<string, DoctorConfigTransform<DoctorConfigFlowTransformContext>>;

const REPAIR_SEQUENCE_TRANSFORMS = {
  "bundled-plugin-load-paths": (config, { env }) => maybeRepairBundledPluginLoadPaths(config, env),
  "codex-routes": (config, { env, blockedCodexProviderPlan }) => {
    const repair = maybeRepairCodexRoutes({
      cfg: config,
      env,
      blockedProviderPlan: blockedCodexProviderPlan,
    });
    return {
      config: repair.cfg,
      changes: repair.changes,
      warnings: repair.warnings,
      advisories: repair.advisories,
    };
  },
  "context-engine-plugin-id": (config, { env }) =>
    maybeRepairContextEnginePluginIdSelector(config, env),
  "invalid-plugin-config": (config) => maybeRepairInvalidPluginConfig(config),
  "allowlist-policy-allow-from": (config) => maybeRepairAllowlistPolicyAllowFrom(config),
  "open-policy-allow-from": (config) => maybeRepairOpenPolicyAllowFrom(config),
  "group-allow-from-fallback": (config) => maybeRepairGroupAllowFromFallback(config),
  "stale-subagent-allowlists": (config) => maybeRepairStaleSubagentAllowlists(config),
  "exec-safe-bins": (config) => maybeRepairExecSafeBinProfiles(config),
} satisfies Record<string, DoctorConfigTransform<DoctorRepairSequenceTransformContext>>;

export type DoctorConfigFlowTransformId = keyof typeof CONFIG_FLOW_TRANSFORMS;
export type DoctorRepairSequenceTransformId = keyof typeof REPAIR_SEQUENCE_TRANSFORMS;

export async function runDoctorConfigFlowTransform(
  id: DoctorConfigFlowTransformId,
  config: OpenClawConfig,
  context: DoctorConfigFlowTransformContext,
): Promise<DoctorConfigTransformResult> {
  const transform: DoctorConfigTransform<DoctorConfigFlowTransformContext> =
    CONFIG_FLOW_TRANSFORMS[id];
  return await transform(config, context);
}

export async function runDoctorRepairSequenceTransform(
  id: DoctorRepairSequenceTransformId,
  config: OpenClawConfig,
  context: DoctorRepairSequenceTransformContext,
): Promise<DoctorConfigTransformResult> {
  const transform: DoctorConfigTransform<DoctorRepairSequenceTransformContext> =
    REPAIR_SEQUENCE_TRANSFORMS[id];
  return await transform(config, context);
}

/** The repair sequence's stale plugin config repair, keeping the plugins it must not prune. */
export function repairDoctorStalePluginConfig(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  preservePluginIds: readonly string[],
) {
  return maybeRepairStalePluginConfig(config, env, {
    preservePluginIds: [...preservePluginIds],
    // A host-version-bound runtime can be absent between core swap and package
    // convergence. Preserve its allow, deny, and explicit enable/disable policy.
    surfacePreservePluginIds: VERSION_BOUND_RUNTIME_PLUGIN_POLICY_IDS_BY_SURFACE,
  });
}
