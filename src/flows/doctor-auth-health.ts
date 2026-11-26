import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { emitDoctorNotes } from "../commands/doctor/emit-notes.js";
import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  recordDoctorHealthWarnings,
  reportDoctorHealthFinding,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";
import type { HealthFinding } from "./health-checks.js";

export async function runAuthProfileMigration(ctx: DoctorHealthFlowContext): Promise<void> {
  ctx.authProfileHealthReady = false;
  // Auth repair depends on the shared-store owner; its receipt records the held-store guidance.
  const sharedAuth = ctx.configResult.stateMigrationStepReceipts?.find(
    (receipt) => receipt.id === "shared-auth-store",
  );
  if (sharedAuth?.outcome === "skipped" && sharedAuth.warnings.length > 0) {
    ctx.retirementOnly = false;
    return;
  }
  const { repairAuthProfileMigration } = await import("../commands/doctor/auth-profile-repair.js");
  const { maybeRepairLegacyOAuthProfileIds } =
    await import("../commands/doctor-auth-legacy-oauth.js");
  const { maybeMigrateLegacyPluginModelCatalogs } =
    await import("../commands/doctor-plugin-model-catalog.js");
  const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");
  if (ctx.configResult.openAICodexAuthProfileIdMap === undefined) {
    const authRepair = await repairAuthProfileMigration({
      cfg: ctx.cfg,
      env: ctx.env,
      prompter: ctx.prompter,
    });
    if (
      authRepair.config !== ctx.cfg ||
      authRepair.storeChanges.length > 0 ||
      authRepair.warnings.length > 0 ||
      authRepair.findings.length > 0
    ) {
      ctx.retirementOnly = false;
    }
    emitDoctorNotes({
      note,
      changeNotes: authRepair.storeChanges,
      warningNotes: [],
    });
    recordDoctorHealthWarnings(ctx, [], authRepair.warnings);
    renderStructuredHealthFindings(ctx, authRepair.findings);
    ctx.cfg = authRepair.config;
    ctx.configResult.openAICodexAuthProfileIdMap = authRepair.profileIdMap;
    if (authRepair.changes.length > 0) {
      ctx.configResult.pendingChangePanels = [
        ...(ctx.configResult.pendingChangePanels ?? []),
        authRepair.changes.join("\n"),
      ];
    }
  }
  const migrationContext = () => ({
    cfg: ctx.cfg,
    ...(ctx.env ? { env: ctx.env } : {}),
    prompter: ctx.prompter,
    runtime: ctx.runtime,
    reportFindings: (findings: readonly HealthFinding[], warnings?: readonly string[]) => {
      if (findings.length > 0 || warnings?.length) {
        ctx.retirementOnly = false;
      }
      recordDoctorHealthWarnings(ctx, warnings ? [] : findings, warnings);
      renderStructuredHealthFindings(ctx, findings);
    },
  });
  if (await maybeMigrateLegacyPluginModelCatalogs(migrationContext())) {
    ctx.retirementOnly = false;
  }
  const modelsBeforeRepair = ctx.cfg.agents?.defaults?.models;
  const legacyOAuthRepair = await maybeRepairLegacyOAuthProfileIds(ctx.cfg, ctx.prompter);
  if (
    legacyOAuthRepair.config !== ctx.cfg ||
    legacyOAuthRepair.retiredProfileCleanupPlans.length > 0 ||
    legacyOAuthRepair.findings.length > 0
  ) {
    ctx.retirementOnly = false;
  }
  recordDoctorHealthWarnings(ctx, legacyOAuthRepair.findings);
  renderStructuredHealthFindings(ctx, legacyOAuthRepair.findings);
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
  const credentials = await maybeMigrateModelCatalogCredentials(migrationContext());
  if (credentials.detected > 0 || credentials.migrated > 0 || credentials.removed > 0) {
    ctx.retirementOnly = false;
  }
  let authProfileHealthReady = true;
  if (
    ctx.configResult.retiredAuthProfileCleanupPlans?.length ||
    ctx.configResult.openAICodexAuthProfileIdMap?.size
  ) {
    ctx.retirementOnly = false;
    const { runRetiredAuthProfileCleanup, runWriteConfigHealth } =
      await import("./doctor-health-contribution-runners.config.js");
    const persisted = await runWriteConfigHealth(ctx, { runPostWriteRepairs: false });
    authProfileHealthReady =
      persisted && !ctx.configWriteRefusal && isDeepStrictEqual(ctx.cfg, ctx.cfgForPersistence);
    if (authProfileHealthReady) {
      await runRetiredAuthProfileCleanup(ctx);
    }
  }
  ctx.authProfileHealthReady = authProfileHealthReady;
  ctx.gatewayDetails = buildGatewayConnectionDetails({ config: ctx.cfg });
  if (ctx.gatewayDetails.remoteFallbackNote) {
    ctx.retirementOnly = false;
    const findings: HealthFinding[] = [
      {
        checkId: "core/doctor/gateway-remote-config",
        severity: "warning",
        category: "fix-now",
        message:
          "Gateway remote mode is configured without a remote Gateway URL; Doctor fell back to the local address.",
        fixHint:
          "Set gateway.remote.url to your remote Gateway address, or set gateway.mode=local if this host owns the Gateway. Run openclaw gateway status after correcting the configuration.",
        docsUrl: "https://docs.openclaw.ai/gateway/remote",
      },
    ];
    recordDoctorHealthWarnings(ctx, [], [ctx.gatewayDetails.remoteFallbackNote]);
    renderStructuredHealthFindings(ctx, findings);
  }
}

export async function runAuthProfileDiagnostics(ctx: DoctorHealthFlowContext): Promise<void> {
  const {
    inspectAuthProfileHealth,
    collectCopilotAmbientTokenFindings,
    collectLegacyCodexProviderOverrideFindings,
    collectSharedAuthStoreFindings,
  } = await import("../commands/doctor-auth.js");
  if (ctx.authProfileHealthReady !== false) {
    renderStructuredHealthFindings(
      ctx,
      await inspectAuthProfileHealth({
        cfg: ctx.cfg,
        prompter: ctx.prompter,
        allowKeychainPrompt: ctx.options.nonInteractive !== true && process.stdin.isTTY,
      }),
    );
  }
  renderStructuredHealthFindings(ctx, await collectLegacyCodexProviderOverrideFindings(ctx.cfg));
  renderStructuredHealthFindings(ctx, await collectSharedAuthStoreFindings(ctx.env));
  renderStructuredHealthFindings(ctx, await collectCopilotAmbientTokenFindings(ctx.cfg, ctx.env));
}

export async function runGatewayAuthHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!ctx.sourceConfigValid) {
    return;
  }
  const { note } = await import("../../packages/terminal-core/src/note.js");
  const { detectGatewayAuthHealth } = await import("./doctor-gateway-auth.js");
  let [finding] = await detectGatewayAuthHealth({
    cfg: ctx.cfg,
    env: ctx.env,
    allowExecSecretRefs: ctx.options.allowExec,
  });
  const { resolveSecretInputRef } = await import("../config/types.secrets.js");
  const gatewayTokenRef = resolveSecretInputRef({
    value: ctx.cfg.gateway?.auth?.token,
    defaults: ctx.cfg.secrets?.defaults,
  }).ref;
  if (!finding) {
    if (gatewayTokenRef && ctx.options.generateGatewayToken === true) {
      note(
        `Gateway token generation skipped because gateway.auth.token is managed by SecretRef ${gatewayTokenRef.source}:${gatewayTokenRef.provider}:${gatewayTokenRef.id}. The referenced credential was left unchanged.`,
        "Gateway auth",
      );
    }
    return;
  }
  if (ctx.options.externallyManaged === true) {
    finding = {
      ...finding,
      fixHint:
        (finding.path === "gateway.auth.password"
          ? "Replace or remove the optional password in the deployment source or its secret owner; keep trusted-proxy authentication configured."
          : "Restore a valid Gateway credential in the deployment source or its secret owner.") +
        " Then redeploy/restart through its supervisor and rerun this externally managed repair.",
    };
  }
  note([finding.message, finding.fixHint].filter(Boolean).join("\n"), "Gateway auth");
  if (ctx.options.externallyManaged === true) {
    reportDoctorHealthFinding(ctx, finding);
    return;
  }
  if (finding.path !== "gateway.auth.token") {
    recordDoctorHealthWarnings(ctx, [finding]);
    return;
  }
  if (gatewayTokenRef) {
    if (
      gatewayTokenRef.source === "store" &&
      finding.requirement === "SECRET_REF_REDACTED_VALUE" &&
      (ctx.options.generateGatewayToken === true ||
        ctx.options.repair === true ||
        ctx.options.yes === true)
    ) {
      const { isRedactedSecretValue } = await import("../config/redact-sentinel.js");
      const { readSecretStoreValue, writeSecretStoreEntry } =
        await import("../secrets/store/secret-store.js");
      const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
      const { resolveOpenClawStateSqlitePath } =
        await import("../state/openclaw-state-db.paths.js");
      const { randomToken } = await import("../commands/onboard-helpers.js");
      const database = { env: ctx.env ?? process.env };
      const entry = { scope: { kind: "team" as const }, name: gatewayTokenRef.id, database };
      try {
        const current = await readSecretStoreValue(entry);
        if (!current.ok || !isRedactedSecretValue(current.value)) {
          note(
            `Secret store entry "${entry.name}" changed; rerun Doctor to inspect it.`,
            "Gateway auth",
          );
          return;
        }
        const databasePath = resolveOpenClawStateSqlitePath(database.env);
        const backup = await createVerifiedSqliteSnapshot({
          sourcePath: databasePath,
          targetPath: `${databasePath}.doctor-gateway-token.${randomUUID()}.bak`,
          preserveRowIds: true,
        });
        const nextToken = randomToken();
        await writeSecretStoreEntry({
          ...entry,
          value: nextToken,
          expectedValue: current.value,
          kind: "secret",
          updatedBy: "doctor",
        });
        note(
          `Regenerated Gateway token in secret store entry "${entry.name}"; gateway.auth.token remains a SecretRef. Backup: ${backup.path}\nRestart the Gateway, then reconnect or re-pair devices with the new token.`,
          "Gateway auth",
        );
      } catch (error) {
        const warning = `Could not repair Gateway token in secret store entry "${entry.name}": ${scrubDoctorErrorMessage(error)}. Rerun \`openclaw doctor --fix\` after resolving the reported problem.`;
        note(warning, "Gateway auth");
        recordDoctorHealthWarnings(ctx, [], [warning]);
      }
      return;
    }
    note(
      `${ctx.options.generateGatewayToken === true ? "Gateway token generation skipped because a SecretRef is configured. " : ""}Doctor will not overwrite gateway.auth.token with a plaintext value.`,
      "Gateway auth",
    );
    return;
  }
  const shouldSetToken =
    ctx.options.generateGatewayToken === true
      ? true
      : ctx.options.nonInteractive === true
        ? false
        : await ctx.prompter.confirmAutoFix({
            message: "Generate and configure a gateway token now?",
            initialValue: true,
          });
  if (!shouldSetToken) {
    return;
  }
  const { randomToken } = await import("../commands/onboard-helpers.js");
  const nextToken = randomToken();
  const config: typeof ctx.cfg = {
    ...ctx.cfg,
    gateway: {
      ...ctx.cfg.gateway,
      auth: {
        ...ctx.cfg.gateway?.auth,
        mode: "token",
        token: nextToken,
      },
    },
  };
  copyConfigResolutionFactsThroughRewrite(ctx.cfg, config);
  ctx.cfg = config;
  note("Gateway token configured.", "Gateway auth");
}
