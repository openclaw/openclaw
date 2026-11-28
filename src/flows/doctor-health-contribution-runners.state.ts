import { isDeepStrictEqual } from "node:util";
import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { isLegacyParentWritableUpdateDoctorPass } from "../commands/doctor/shared/update-phase.js";
import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { noteDoctorRepairResult } from "./doctor-health-contribution-utils.js";
import {
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";

/** The repair rewrites exactly the manifests this collects. */
export async function checkLegacyPluginManifestPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const [
    { collectLegacyPluginManifestContractMigrations },
    { decideDoctorPendingFromLiveStores },
    { resolveOpenClawStateSqlitePath },
  ] = await Promise.all([
    import("../commands/doctor-plugin-manifests.js"),
    import("../commands/doctor-live-store-pending.js"),
    import("../state/openclaw-state-db.paths.js"),
  ]);
  // Manifest discovery reads the installed plugin index from the state database.
  return decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath()], () =>
    collectLegacyPluginManifestContractMigrations({ config: ctx.cfg, env: process.env }).length > 0
      ? "work"
      : "none",
  );
}

export async function runLegacyPluginManifestHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyPluginManifestContracts } =
    await import("../commands/doctor-plugin-manifests.js");
  const pluginInventoryChanged = await maybeRepairLegacyPluginManifestContracts({
    config: ctx.cfg,
    env: process.env,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
  });
  if (pluginInventoryChanged) {
    ctx.invalidatePluginMetadataSnapshot?.();
  }
}

export async function checkAgentMemorySchemaPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const { checkDoctorAgentMemorySchemaPending } =
    await import("../commands/doctor-agent-memory-schema.js");
  return checkDoctorAgentMemorySchemaPending({
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runAgentMemorySchemaHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteDoctorAgentMemorySchemaHealth } =
    await import("../commands/doctor-agent-memory-schema.js");
  await noteDoctorAgentMemorySchemaHealth({
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

export async function runCodexSessionRouteHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairCodexSessionRoutes } =
    await import("../commands/doctor/shared/codex-route-warnings.js");
  const result = await maybeRepairCodexSessionRoutes({
    cfg: ctx.cfg,
    modelReplacements: ctx.options.modelReplacements,
    ...(ctx.configResult.retiredModelRefConfig
      ? { retiredModelRefConfig: ctx.configResult.retiredModelRefConfig }
      : {}),
    env: ctx.env ?? process.env,
    ...(!ctx.prompter.shouldRepair && ctx.configResult.providerRenames?.length
      ? { providerRenames: ctx.configResult.providerRenames }
      : {}),
    shouldRepair: ctx.prompter.shouldRepair,
    ...(ctx.configResult.blockedCodexModelIdentities?.length
      ? { blockedModelIdentities: new Set(ctx.configResult.blockedCodexModelIdentities) }
      : {}),
    ...(ctx.configResult.openAICodexAuthProfileIdMap?.size
      ? {
          authProfileIdMap: ctx.configResult.openAICodexAuthProfileIdMap,
          ...(!ctx.prompter.shouldRepair ? { authProfileOnly: true } : {}),
        }
      : {}),
  });
  if (result.requiresFullDoctor || result.warnings.length > 0) {
    ctx.retirementOnly = false;
  }
  noteDoctorRepairResult(result);
}

export async function runSessionTranscriptsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionTranscriptHealth } = await import("../commands/doctor-session-transcripts.js");
  await noteSessionTranscriptHealth({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
    integrityCheck: ctx.options.fullIntegrityCheck ? "full" : "quick",
    onWarnings: (warnings) => recordDoctorHealthWarnings(ctx, [], warnings),
    onFindings: (findings) => renderStructuredHealthFindings(ctx, findings),
    ...(ctx.configResult.postSessionPluginMigration
      ? { postSessionPluginMigration: ctx.configResult.postSessionPluginMigration }
      : {}),
    ...(ctx.configResult.postSessionPluginMigrationPlanBound
      ? { postSessionPluginMigrationPlanBound: true }
      : {}),
    onStepReceipt: (receipt) => {
      ctx.configResult.stateMigrationStepReceipts ??= [];
      ctx.configResult.stateMigrationStepReceipts.push(receipt);
      if (receipt.outcome === "deferred" || receipt.warnings.length > 0) {
        ctx.retirementOnly = false;
      }
    },
  });
}

function sessionTranscriptRepairInputs(ctx: DoctorHealthFlowContext) {
  return {
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
    integrityCheck: ctx.options.fullIntegrityCheck ? ("full" as const) : ("quick" as const),
  };
}

export async function checkSessionTranscriptHeadersContributionPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const { checkSessionTranscriptHeaderRepairPending } =
    await import("../commands/doctor-session-transcript-headers.js");
  return checkSessionTranscriptHeaderRepairPending(sessionTranscriptRepairInputs(ctx));
}

export async function runSessionTranscriptHeadersHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { noteSessionTranscriptHeaderHealth } =
    await import("../commands/doctor-session-transcript-headers.js");
  await noteSessionTranscriptHeaderHealth(sessionTranscriptRepairInputs(ctx));
}

export async function checkSessionTranscriptLabelsContributionPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const { checkSessionTranscriptLabelRepairPending } =
    await import("../commands/doctor-session-transcript-labels.js");
  return checkSessionTranscriptLabelRepairPending(sessionTranscriptRepairInputs(ctx));
}

export async function runSessionTranscriptLabelsHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { noteSessionTranscriptLabelHealth } =
    await import("../commands/doctor-session-transcript-labels.js");
  await noteSessionTranscriptLabelHealth(sessionTranscriptRepairInputs(ctx));
}

export async function runLegacyCronHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyCronStore, noteLegacyWhatsAppCrontabHealthCheck } =
    await import("../commands/doctor/cron/index.js");
  await measureGatewayBootstrapStep("doctor.legacy-cron.crontab", () =>
    noteLegacyWhatsAppCrontabHealthCheck(),
  );
  await measureGatewayBootstrapStep("doctor.legacy-cron.store", () =>
    maybeRepairLegacyCronStore({
      cfg: ctx.cfg,
      options: ctx.options,
      prompter: ctx.prompter,
    }),
  );
  const { maybeRepairCronInferenceBindings } =
    await import("../commands/doctor/cron/inference-binding-migration.js");
  const inference = await measureGatewayBootstrapStep("doctor.legacy-cron.inference", () =>
    maybeRepairCronInferenceBindings({
      cfg: ctx.cfg,
      env: ctx.env,
      shouldRepair: ctx.prompter.shouldRepair,
    }),
  );
  noteDoctorRepairResult(inference);
  recordDoctorHealthWarnings(ctx, [], inference.warnings);
  const { noteScheduledContextReport } =
    await import("../commands/doctor/cron/execution-context-check.js");
  await measureGatewayBootstrapStep("doctor.legacy-cron.execution-context", () =>
    noteScheduledContextReport({ cfg: ctx.cfg, env: ctx.env }),
  );
}

/**
 * Read-only: whether `runLegacyStateHealth` would write. Its two core repairs answer for
 * themselves; the legacy-state migration runs unless preflight already migrated this exact
 * config; the exec-approval cleanup removes only generated grants the store still holds.
 */
export async function checkLegacyStatePending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const { checkCoreContributionRepairsPending } =
    await import("./doctor-health-contribution-core.js");
  const core = await checkCoreContributionRepairsPending(ctx, [
    "core/doctor/removed-workspaces-state",
    "core/doctor/session-archive-read-cache",
  ]);
  if (core !== "none") {
    return core;
  }
  if (
    !(ctx.options.repair === true || ctx.options.yes === true) ||
    !isDeepStrictEqual(ctx.configResult.preflightLegacyStateConfig, ctx.cfg)
  ) {
    // The migration then decides through its own detection, whose snapshot read can copy the
    // state database, so it is not repeated here.
    return "work";
  }
  const [
    { countStoredObsoleteGeneratedExecApprovals },
    { decideDoctorPendingFromLiveStores },
    { resolveOpenClawStateSqlitePath },
  ] = await Promise.all([
    import("../infra/exec-approvals-generated-migration.js"),
    import("../commands/doctor-live-store-pending.js"),
    import("../state/openclaw-state-db.paths.js"),
  ]);
  return decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath()], () =>
    countStoredObsoleteGeneratedExecApprovals() > 0 ? "work" : "none",
  );
}

/**
 * Read-only: the plugin registry repair's own no-op test. The registry lives in the state
 * database, so it decides only while a connection holds it. The repair still runs that test
 * inside the stop, where the alternative, the plugin lease, writes rows on every run.
 */
export async function checkPluginRegistryContributionPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  const [
    { checkPluginRegistryRepairPending },
    { decideDoctorPendingFromLiveStores },
    { resolveOpenClawStateSqlitePath },
  ] = await Promise.all([
    import("../commands/doctor-plugin-registry.js"),
    import("../commands/doctor-live-store-pending.js"),
    import("../state/openclaw-state-db.paths.js"),
  ]);
  return decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath()], () =>
    checkPluginRegistryRepairPending({
      config: ctx.cfg,
      env: process.env,
      prompter: ctx.prompter,
    }),
  );
}

/**
 * Read-only: the Telegram General-topic repair's own detection, which opens each agent
 * database. It decides only while a connection holds the stores it reads.
 */
export async function checkTelegramGeneralTopicConversationsPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  if (!ctx.prompter.shouldRepair) {
    return "none";
  }
  const env = ctx.env ?? process.env;
  const [
    { checkCoreContributionRepairsPending },
    { listTelegramGeneralTopicConversationDatabasePaths },
    { decideDoctorPendingFromLiveStores },
    { resolveOpenClawStateSqlitePath },
  ] = await Promise.all([
    import("./doctor-health-contribution-core.js"),
    import("../commands/doctor-telegram-general-topic-conversations.js"),
    import("../commands/doctor-live-store-pending.js"),
    import("../state/openclaw-state-db.paths.js"),
  ]);
  return decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath(env)], () =>
    decideDoctorPendingFromLiveStores(
      listTelegramGeneralTopicConversationDatabasePaths(ctx.cfg, env),
      () =>
        checkCoreContributionRepairsPending(ctx, [
          "core/doctor/telegram-general-topic-conversations",
        ]),
    ),
  );
}

export async function checkLegacyRuntimeFilesContributionPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  if (!ctx.prompter.shouldRepair) {
    return "none";
  }
  const { checkLegacyRuntimeFilesPending } = await import("../commands/doctor-usage-cost-cache.js");
  return checkLegacyRuntimeFilesPending(ctx.env);
}

function configuredPluginInstallReleaseInputs(ctx: DoctorHealthFlowContext) {
  return {
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    touchedVersion: ctx.configResult.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion,
  };
}

export async function checkConfiguredPluginInstallReleasePending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  if (!ctx.sourceConfigValid || !ctx.prompter.shouldRepair) {
    return "none";
  }
  const [
    { checkConfiguredPluginInstallReleaseStepPending },
    { decideDoctorPendingFromLiveStores },
    { resolveOpenClawStateSqlitePath },
  ] = await Promise.all([
    import("../commands/doctor/shared/release-configured-plugin-installs.js"),
    import("../commands/doctor-live-store-pending.js"),
    import("../state/openclaw-state-db.paths.js"),
  ]);
  const inputs = configuredPluginInstallReleaseInputs(ctx);
  // Plugin install records and metadata snapshots live in the state database.
  return decideDoctorPendingFromLiveStores([resolveOpenClawStateSqlitePath(inputs.env)], () =>
    checkConfiguredPluginInstallReleaseStepPending(inputs),
  );
}

export async function checkLegacyPluginSourceCapturesContributionPending(
  ctx: DoctorHealthFlowContext,
): Promise<DoctorMaintenancePending> {
  if (!ctx.prompter.shouldRepair) {
    return "none";
  }
  const { checkLegacyPluginSourceCapturesPending } =
    await import("../commands/doctor-plugin-source-captures.js");
  return checkLegacyPluginSourceCapturesPending(ctx.env ?? process.env);
}

export async function runConfiguredPluginInstallReleaseHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  if (!ctx.sourceConfigValid || !ctx.prompter.shouldRepair) {
    return;
  }
  const { maybeRunConfiguredPluginInstallReleaseStep } =
    await import("../commands/doctor/shared/release-configured-plugin-installs.js");
  const { VERSION } = await import("../version.js");
  const result = await maybeRunConfiguredPluginInstallReleaseStep(
    configuredPluginInstallReleaseInputs(ctx),
  );
  if (result.pluginInventoryChanged) {
    ctx.invalidatePluginMetadataSnapshot?.();
  }
  if (result.postInstallDoctorResult) {
    ctx.postInstallDoctorResult = result.postInstallDoctorResult;
  }
  noteDoctorRepairResult(result);
  if (!result.touchedConfig) {
    return;
  }
  const lastTouchedVersion = isLegacyParentWritableUpdateDoctorPass(ctx.env ?? process.env)
    ? ctx.configResult.sourceLastTouchedVersion?.trim() ||
      ctx.cfg.meta?.lastTouchedVersion ||
      VERSION
    : VERSION;
  const config = { ...ctx.cfg, meta: { ...ctx.cfg.meta, lastTouchedVersion } };
  copyConfigResolutionFactsThroughRewrite(ctx.cfg, config);
  ctx.cfg = config;
  writeConfigMachineState("config.lastTouchedAt", new Date().toISOString());
}
