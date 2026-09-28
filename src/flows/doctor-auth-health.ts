import { isDeepStrictEqual } from "node:util";
import { emitDoctorNotes } from "../commands/doctor/emit-notes.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

export async function runAuthProfileMigration(ctx: DoctorHealthFlowContext): Promise<void> {
  ctx.authProfileHealthReady = false;
  // Auth repair depends on the shared-store owner; its receipt records the held-store guidance.
  const sharedAuth = ctx.configResult.stateMigrationStepReceipts?.find(
    (receipt) => receipt.id === "shared-auth-store",
  );
  if (sharedAuth?.outcome === "skipped" && sharedAuth.warnings.length > 0) {
    return;
  }
  const { repairAuthProfileMigration } = await import("../commands/doctor/auth-profile-repair.js");
  const { maybeRepairLegacyOAuthProfileIds } =
    await import("../commands/doctor-auth-legacy-oauth.js");
  const { maybeRepairLegacyOAuthSidecarProfiles } =
    await import("../commands/doctor-auth-oauth-sidecar.js");
  const { maybeMigrateLegacyPluginModelCatalogs } =
    await import("../commands/doctor-plugin-model-catalog.js");
  const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  await maybeRepairLegacyOAuthSidecarProfiles({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
  if (ctx.configResult.openAICodexAuthProfileIdMap === undefined) {
    const authRepair = await repairAuthProfileMigration({
      cfg: ctx.cfg,
      env: ctx.env,
      prompter: ctx.prompter,
    });
    emitDoctorNotes({
      note,
      changeNotes: authRepair.storeChanges,
      warningNotes: authRepair.warnings,
    });
    ctx.cfg = authRepair.config;
    ctx.configResult.openAICodexAuthProfileIdMap = authRepair.profileIdMap;
    if (authRepair.changes.length > 0) {
      ctx.configResult.pendingChangePanels = [
        ...(ctx.configResult.pendingChangePanels ?? []),
        authRepair.changes.join("\n"),
      ];
    }
  }
  await maybeMigrateLegacyPluginModelCatalogs({
    cfg: ctx.cfg,
    ...(ctx.env ? { env: ctx.env } : {}),
    prompter: ctx.prompter,
    runtime: ctx.runtime,
  });
  const modelsBeforeRepair = ctx.cfg.agents?.defaults?.models;
  const legacyOAuthRepair = await maybeRepairLegacyOAuthProfileIds(ctx.cfg, ctx.prompter);
  ctx.cfg = legacyOAuthRepair.config;
  if (legacyOAuthRepair.retiredProfileCleanupPlans.length > 0) {
    ctx.configResult.retiredAuthProfileCleanupPlans = [
      ...(ctx.configResult.retiredAuthProfileCleanupPlans ?? []),
      ...legacyOAuthRepair.retiredProfileCleanupPlans,
    ];
  }
  if (!isDeepStrictEqual(modelsBeforeRepair, ctx.cfg.agents?.defaults?.models)) {
    ctx.configResult.explicitSetPaths = [
      ...(ctx.configResult.explicitSetPaths ?? []),
      ["agents", "defaults", "models"],
    ];
  }
  const { maybeMigrateModelCatalogCredentials } =
    await import("../commands/doctor-model-catalog-credentials.js");
  await maybeMigrateModelCatalogCredentials({
    cfg: ctx.cfg,
    ...(ctx.env ? { env: ctx.env } : {}),
    prompter: ctx.prompter,
    runtime: ctx.runtime,
  });
  let authProfileHealthReady = true;
  if (
    ctx.configResult.retiredAuthProfileCleanupPlans?.length ||
    ctx.configResult.openAICodexAuthProfileIdMap?.size
  ) {
    const { runRetiredAuthProfileCleanup, runWriteConfigHealth } =
      await import("./doctor-health-contribution-runners.config.js");
    await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
    authProfileHealthReady =
      !ctx.configWriteRefusal && isDeepStrictEqual(ctx.cfg, ctx.cfgForPersistence);
    if (authProfileHealthReady) {
      await runRetiredAuthProfileCleanup(ctx);
    }
  }
  ctx.authProfileHealthReady = authProfileHealthReady;
  ctx.gatewayDetails = buildGatewayConnectionDetails({ config: ctx.cfg });
  if (ctx.gatewayDetails.remoteFallbackNote) {
    note(ctx.gatewayDetails.remoteFallbackNote, "Gateway");
  }
}

export async function runAuthProfileDiagnostics(ctx: DoctorHealthFlowContext): Promise<void> {
  const {
    noteAuthProfileHealth,
    noteCopilotAmbientToken,
    noteLegacyCodexProviderOverride,
    noteSharedAuthStoreStatus,
  } = await import("../commands/doctor-auth.js");
  if (ctx.authProfileHealthReady !== false) {
    await noteAuthProfileHealth({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
      allowKeychainPrompt: ctx.options.nonInteractive !== true && process.stdin.isTTY,
    });
  }
  noteLegacyCodexProviderOverride(ctx.cfg);
  noteSharedAuthStoreStatus(ctx.env);
  noteCopilotAmbientToken(ctx.cfg, ctx.env);
}
