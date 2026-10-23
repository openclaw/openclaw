import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { noteDoctorRepairResult } from "./doctor-health-contribution-utils.js";
import {
  recordDoctorHealthWarnings,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";

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
    },
  });
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
}
