// Doctor health contribution helpers collect health checks from plugin manifests.
import fs from "node:fs";
import type { probeGatewayMemoryStatus } from "../commands/doctor-gateway-health.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import {
  isLegacyParentWritableUpdateDoctorPass,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
} from "../commands/doctor/shared/update-phase.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildGatewayConnectionDetails } from "../gateway/call.js";
import type { UpdatePostInstallDoctorResult } from "../infra/update-doctor-result.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { HealthCheckInput, RunnableHealthCheck } from "./health-check-runner-types.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";
import type { FlowContribution } from "./types.js";

type DoctorFlowMode = "local" | "remote";

type DoctorConfigResult = {
  cfg: OpenClawConfig;
  path?: string;
  shouldWriteConfig?: boolean;
  sourceConfigValid?: boolean;
  sourceLastTouchedVersion?: string;
  skipPluginValidationOnWrite?: boolean;
  preservedLegacyRootKeys?: readonly string[];
};

export type DoctorHealthFlowContext = {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  prompter: DoctorPrompter;
  configResult: DoctorConfigResult;
  cfg: OpenClawConfig;
  cfgForPersistence: OpenClawConfig;
  sourceConfigValid: boolean;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  gatewayDetails?: ReturnType<typeof buildGatewayConnectionDetails>;
  healthOk?: boolean;
  gatewayHealthAuthenticated?: boolean;
  gatewayHealthSkipped?: boolean;
  gatewayStatus?: import("../commands/status.types.js").StatusSummary;
  gatewayMemoryProbe?: Awaited<ReturnType<typeof probeGatewayMemoryStatus>>;
  postInstallDoctorResult?: UpdatePostInstallDoctorResult;
};

type DoctorHealthContribution = FlowContribution & {
  kind: "core";
  surface: "health";
  // Structured checks listed here belong to this ordered doctor contribution;
  // when legacy run() is absent they also own the doctor execution path.
  healthChecks: readonly HealthCheckInput[];
  healthCheckIds: readonly string[];
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

type DoctorContributionHealthCheck =
  | (Omit<HealthCheck, "id" | "kind" | "source"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    })
  | (Omit<RunnableHealthCheck, "id" | "kind" | "source"> & {
      readonly id?: string;
      readonly kind?: "core";
      readonly source?: string;
    });

const loadAgentDefaultsModule = async () => await import("../agents/defaults.js");
const loadAgentScopeModule = async () => await import("../agents/agent-scope.js");
const loadCommandFormatModule = async () => await import("../cli/command-format.js");
const loadConfigModule = async () => await import("../config/config.js");
const loadDoctorCoreChecksModule = async () => await import("./doctor-core-checks.js");
const loadDoctorStateIntegrityModule = async () =>
  await import("../commands/doctor-state-integrity.js");
const loadHealthCheckRegistryModule = async () => await import("./health-check-registry.js");
const loadModelCatalogModule = async () => await import("../agents/model-catalog.js");
const loadModelSelectionModule = async () => await import("../agents/model-selection.js");
const loadNoteModule = async () => await import("../../packages/terminal-core/src/note.js");
const loadOnboardHelpersModule = async () => await import("../commands/onboard-helpers.js");
const loadSecretTypesModule = async () => await import("../config/types.secrets.js");

function isUpdateDoctorRun(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const value = env.OPENCLAW_UPDATE_IN_PROGRESS;
  return value === "1" || value === "true";
}

function resolveDoctorMode(cfg: OpenClawConfig): DoctorFlowMode {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldSkipLegacyUpdateDoctorConfigWrite(params: {
  env: NodeJS.ProcessEnv;
}): boolean {
  if (!isTruthyEnvValue(params.env.OPENCLAW_UPDATE_IN_PROGRESS)) {
    return false;
  }
  if (isTruthyEnvValue(params.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV])) {
    return false;
  }
  return true;
}

export function createDoctorHealthContribution(params: {
  id: string;
  label: string;
  healthCheckIds?: readonly string[];
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
  hint?: string;
  run?: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution {
  const healthChecks = normalizeHealthChecks({
    contributionId: params.id,
    healthChecks: params.healthChecks,
  });
  const healthCheckIds = params.healthCheckIds ?? healthChecks.map((check) => check.id);
  if (params.run === undefined && healthChecks.length === 0) {
    throw new Error(`doctor contribution ${params.id} must define run or healthChecks`);
  }
  return {
    id: params.id,
    kind: "core",
    surface: "health",
    option: {
      value: params.id,
      label: params.label,
      ...(params.hint ? { hint: params.hint } : {}),
    },
    source: "doctor",
    healthChecks,
    healthCheckIds,
    run:
      params.run ??
      ((ctx) =>
        runStructuredDoctorHealthContribution({
          contributionId: params.id,
          ctx,
          checks: healthChecks,
        })),
  };
}

function normalizeHealthChecks(params: {
  contributionId: string;
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
}): readonly HealthCheckInput[] {
  if (params.healthChecks === undefined) {
    return [];
  }
  const checks = Array.isArray(params.healthChecks) ? params.healthChecks : [params.healthChecks];
  return checks.map((check) =>
    normalizeContributionHealthCheck({
      check,
      contributionId: params.contributionId,
      count: checks.length,
    }),
  );
}

function normalizeContributionHealthCheck(params: {
  check: DoctorContributionHealthCheck;
  contributionId: string;
  count: number;
}): HealthCheckInput {
  const id =
    params.check.id ??
    (params.count === 1 ? deriveCoreHealthCheckId(params.contributionId) : undefined);
  if (id === undefined) {
    throw new Error(
      `doctor contribution ${params.contributionId} must specify health check ids when it declares multiple healthChecks`,
    );
  }
  return {
    ...params.check,
    id,
    kind: params.check.kind ?? "core",
    source: params.check.source ?? "doctor",
  };
}

function deriveCoreHealthCheckId(contributionId: string): string {
  if (contributionId.startsWith("doctor:")) {
    return `core/doctor/${contributionId.slice("doctor:".length)}`;
  }
  return `core/doctor/${contributionId}`;
}

async function runStructuredDoctorHealthContribution(params: {
  contributionId: string;
  ctx: DoctorHealthFlowContext;
  checks: readonly HealthCheckInput[];
}): Promise<void> {
  if (params.checks.length === 0) {
    throw new Error(`doctor contribution ${params.contributionId} has no structured health`);
  }
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } =
    await import("../agents/agent-scope.js");
  const workspaceDir = resolveAgentWorkspaceDir(
    params.ctx.cfg,
    resolveDefaultAgentId(params.ctx.cfg),
  );
  const result = await runDoctorHealthRepairs(
    {
      mode: "fix",
      runtime: params.ctx.runtime,
      cfg: params.ctx.cfg,
      cwd: workspaceDir,
      configPath: params.ctx.configPath,
      dryRun: !params.ctx.prompter.shouldRepair,
      allowExecSecretRefs: params.ctx.options.allowExec === true,
    },
    {
      checks: params.checks,
      dryRun: !params.ctx.prompter.shouldRepair,
    },
  );
  params.ctx.cfg = result.config;
  renderStructuredHealthFindings(params.ctx, result.findings);
  for (const warning of result.warnings) {
    params.ctx.runtime.error(warning);
  }
  for (const change of result.changes) {
    params.ctx.runtime.log(change);
  }
}

function renderStructuredHealthFindings(
  ctx: DoctorHealthFlowContext,
  findings: readonly HealthFinding[],
): void {
  for (const finding of findings) {
    const write = finding.severity === "error" ? ctx.runtime.error : ctx.runtime.log;
    write(formatStructuredHealthFinding(finding));
    if (finding.fixHint !== undefined) {
      ctx.runtime.log(`  fix: ${finding.fixHint}`);
    }
  }
}

function formatStructuredHealthFinding(finding: HealthFinding): string {
  const where = finding.path !== undefined ? ` ${finding.path}` : "";
  const line = finding.line !== undefined ? `:${finding.line}` : "";
  return `[${finding.severity}] ${finding.checkId}${where}${line} - ${finding.message}`;
}

async function runGatewayConfigHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { formatCliCommand } = await loadCommandFormatModule();
  const { hasAmbiguousGatewayAuthModeConfig } = await import("../gateway/auth-mode-policy.js");
  const { note } = await loadNoteModule();
  if (!ctx.cfg.gateway?.mode) {
    const lines = [
      "gateway.mode is unset; gateway start will be blocked.",
      `Fix: run ${formatCliCommand("openclaw configure")} and set Gateway mode (local/remote).`,
      `Or set directly: ${formatCliCommand("openclaw config set gateway.mode local")}`,
    ];
    if (!fs.existsSync(ctx.configPath)) {
      lines.push(`Missing config: run ${formatCliCommand("openclaw setup")} first.`);
    }
    note(lines.join("\n"), "Gateway");
  }
  if (resolveDoctorMode(ctx.cfg) === "local" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
    note(
      [
        "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset.",
        "Set an explicit mode to avoid ambiguous auth selection and startup/runtime failures.",
        `Set token mode: ${formatCliCommand("openclaw config set gateway.auth.mode token")}`,
        `Set password mode: ${formatCliCommand("openclaw config set gateway.auth.mode password")}`,
      ].join("\n"),
      "Gateway auth",
    );
  }
}

async function runAuthProfileHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyFlatAuthProfileStores, maybeRepairCanonicalApiKeyFieldAlias } =
    await import("../commands/doctor-auth-flat-profiles.js");
  const { maybeRepairLegacyOAuthProfileIds } =
    await import("../commands/doctor-auth-legacy-oauth.js");
  const { maybeRepairLegacyOAuthSidecarProfiles } =
    await import("../commands/doctor-auth-oauth-sidecar.js");
  const { noteAuthProfileHealth, noteLegacyCodexProviderOverride } =
    await import("../commands/doctor-auth.js");
  const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
  const { note } = await loadNoteModule();
  await maybeRepairLegacyFlatAuthProfileStores({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
  await maybeRepairCanonicalApiKeyFieldAlias({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
  await maybeRepairLegacyOAuthSidecarProfiles({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
  ctx.cfg = await maybeRepairLegacyOAuthProfileIds(ctx.cfg, ctx.prompter);
  await noteAuthProfileHealth({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
    allowKeychainPrompt: ctx.options.nonInteractive !== true && process.stdin.isTTY,
  });
  noteLegacyCodexProviderOverride(ctx.cfg);
  ctx.gatewayDetails = buildGatewayConnectionDetails({ config: ctx.cfg });
  if (ctx.gatewayDetails.remoteFallbackNote) {
    note(ctx.gatewayDetails.remoteFallbackNote, "Gateway");
  }
}

async function runGatewayAuthHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { resolveSecretInputRef } = await loadSecretTypesModule();
  const { buildGatewayTokenSecretRefFixHint, buildGatewayTokenSecretRefUnavailableMessage } =
    await loadDoctorCoreChecksModule();
  const { resolveGatewayAuth } = await import("../gateway/auth.js");
  const { resolveGatewayAuthToken } = await import("../gateway/auth-token-resolution.js");
  const { note } = await loadNoteModule();
  const { randomToken } = await loadOnboardHelpersModule();
  if (resolveDoctorMode(ctx.cfg) !== "local" || !ctx.sourceConfigValid) {
    return;
  }
  const gatewayTokenRef = resolveSecretInputRef({
    value: ctx.cfg.gateway?.auth?.token,
    defaults: ctx.cfg.secrets?.defaults,
  }).ref;
  const auth = resolveGatewayAuth({
    authConfig: ctx.cfg.gateway?.auth,
    tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off",
  });
  // Modes that don't need a token: password, none, trusted-proxy.
  // This aligns with hasExplicitGatewayInstallAuthMode() in auth-install-policy.ts.
  // Previously, only "password" and "token" (with a token present) were excluded,
  // causing doctor --fix to overwrite trusted-proxy/none configs with token mode.
  const hasInlineToken = typeof auth.token === "string" && auth.token.trim() !== "";
  const needsToken =
    auth.mode !== "password" &&
    auth.mode !== "none" &&
    auth.mode !== "trusted-proxy" &&
    (auth.mode !== "token" || !hasInlineToken || Boolean(gatewayTokenRef));
  if (!needsToken) {
    return;
  }
  let unresolvedRefReason: string | undefined;
  if (gatewayTokenRef && gatewayTokenRef.source === "exec") {
    const { getSkippedExecRefStaticError } = await import("../secrets/exec-resolution-policy.js");
    const staticError = getSkippedExecRefStaticError({ ref: gatewayTokenRef, config: ctx.cfg });
    if (staticError) {
      unresolvedRefReason = undefined;
    } else if (ctx.options.allowExec !== true) {
      return;
    } else {
      const resolvedToken = await resolveGatewayAuthToken({
        cfg: ctx.cfg,
        env: ctx.env ?? process.env,
        unresolvedReasonStyle: "detailed",
        envFallback: "never",
      });
      if (resolvedToken.source === "secretRef") {
        return;
      }
      unresolvedRefReason = resolvedToken.unresolvedRefReason;
    }
  } else {
    const resolvedToken = await resolveGatewayAuthToken({
      cfg: ctx.cfg,
      env: ctx.env ?? process.env,
      unresolvedReasonStyle: "detailed",
      envFallback: gatewayTokenRef ? "never" : "always",
    });
    if (gatewayTokenRef ? resolvedToken.source === "secretRef" : resolvedToken.token) {
      return;
    }
    unresolvedRefReason = resolvedToken.unresolvedRefReason;
  }
  if (gatewayTokenRef) {
    const reason = buildGatewayTokenSecretRefUnavailableMessage({
      cfg: ctx.cfg,
      ref: gatewayTokenRef,
      unresolvedRefReason,
    });
    note(
      [
        reason,
        "Doctor will not overwrite gateway.auth.token with a plaintext value.",
        buildGatewayTokenSecretRefFixHint(gatewayTokenRef),
      ].join("\n"),
      "Gateway auth",
    );
    return;
  }

  note(
    "Gateway auth is off or missing a token. Token auth is now the recommended default (including loopback).",
    "Gateway auth",
  );
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
  const nextToken = randomToken();
  ctx.cfg = {
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
  note("Gateway token configured.", "Gateway auth");
}

async function runCommandOwnerHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteCommandOwnerHealth } = await import("../commands/doctor-command-owner.js");
  noteCommandOwnerHealth(ctx.cfg);
}

async function runStructuredHealthRepairs(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!ctx.prompter.shouldRepair) {
    return;
  }
  const { registerBundledHealthChecks } = await import("./bundled-health-checks.js");
  const { listExtensionHealthChecksForDoctor } = await loadHealthCheckRegistryModule();
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await loadAgentScopeModule();
  const { note } = await loadNoteModule();

  const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
  registerBundledHealthChecks({ cfg: ctx.cfg, cwd: workspaceDir });
  const checks = listExtensionHealthChecksForDoctor(await resolveDoctorContributionHealthChecks());
  const result = await runDoctorHealthRepairs(
    {
      mode: "fix",
      runtime: ctx.runtime,
      cfg: ctx.cfg,
      cwd: workspaceDir,
      configPath: ctx.configPath,
    },
    { checks },
  );
  ctx.cfg = result.config;
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

async function runClaudeCliHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
  noteClaudeCliHealth(ctx.cfg);
}

async function runCoreContributionHealthRepair(
  ctx: DoctorHealthFlowContext,
  checkIds: readonly string[],
): Promise<void> {
  if (!ctx.prompter.shouldRepair || checkIds.length === 0) {
    return;
  }
  const { CORE_HEALTH_CHECKS } = await import("./doctor-core-checks.js");
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } =
    await import("../agents/agent-scope.js");
  const { note } = await import("../../packages/terminal-core/src/note.js");

  const selectedIds = new Set(checkIds);
  const checks = CORE_HEALTH_CHECKS.filter((check) => selectedIds.has(check.id));
  if (checks.length === 0) {
    return;
  }
  const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
  const result = await runDoctorHealthRepairs(
    {
      mode: "fix",
      runtime: ctx.runtime,
      cfg: ctx.cfg,
      cwd: workspaceDir,
      configPath: ctx.configPath,
    },
    { checks },
  );
  ctx.cfg = result.config;
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

async function runLegacyStateHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { detectLegacyStateMigrations, runLegacyStateMigrations } =
    await import("../commands/doctor-state-migrations.js");
  const { note } = await loadNoteModule();
  const legacyState = await detectLegacyStateMigrations({ cfg: ctx.cfg });
  if (legacyState.warnings.length > 0) {
    note(legacyState.warnings.join("\n"), "Doctor warnings");
  }
  if (legacyState.preview.length === 0) {
    return;
  }
  note(legacyState.preview.join("\n"), "Legacy state detected");
  const migrate =
    ctx.options.nonInteractive === true
      ? true
      : await ctx.prompter.confirm({
          message: "Migrate legacy state (sessions/agent/WhatsApp auth) now?",
          initialValue: true,
        });
  if (!migrate) {
    return;
  }
  const migrated = await runLegacyStateMigrations({
    detected: legacyState,
    recoverCorruptTargetStore: ctx.options.repair === true || ctx.options.yes === true,
  });
  if (migrated.changes.length > 0) {
    note(migrated.changes.join("\n"), "Doctor changes");
  }
  if (migrated.warnings.length > 0) {
    note(migrated.warnings.join("\n"), "Doctor warnings");
  }
}

async function runLegacyPluginManifestHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyPluginManifestContracts } =
    await import("../commands/doctor-plugin-manifests.js");
  await maybeRepairLegacyPluginManifestContracts({
    config: ctx.cfg,
    env: process.env,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
  });
}

async function runPluginRegistryHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairPluginRegistryState } = await import("../commands/doctor-plugin-registry.js");
  ctx.cfg = await maybeRepairPluginRegistryState({
    config: ctx.cfg,
    env: process.env,
    prompter: ctx.prompter,
  });
}

async function runReleaseConfiguredPluginInstallsHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  if (!ctx.sourceConfigValid) {
    return;
  }
  if (!ctx.prompter.shouldRepair) {
    return;
  }
  const { maybeRunConfiguredPluginInstallReleaseStep } =
    await import("../commands/doctor/shared/release-configured-plugin-installs.js");
  const { note } = await loadNoteModule();
  const { VERSION } = await import("../version.js");
  const result = await maybeRunConfiguredPluginInstallReleaseStep({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    touchedVersion: ctx.configResult.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion,
  });
  if (result.postInstallDoctorResult) {
    ctx.postInstallDoctorResult = result.postInstallDoctorResult;
  }
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
  if (!result.touchedConfig) {
    return;
  }
  const lastTouchedVersion = isLegacyParentWritableUpdateDoctorPass(ctx.env ?? process.env)
    ? ctx.configResult.sourceLastTouchedVersion?.trim() ||
      ctx.cfg.meta?.lastTouchedVersion ||
      VERSION
    : VERSION;
  ctx.cfg = {
    ...ctx.cfg,
    meta: {
      ...ctx.cfg.meta,
      lastTouchedVersion,
      lastTouchedAt: new Date().toISOString(),
    },
  };
}

async function runDiskSpaceHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteDiskSpace } = await import("../commands/doctor-disk-space.js");
  noteDiskSpace(ctx.cfg);
}

async function runStateIntegrityHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteStateIntegrity } = await loadDoctorStateIntegrityModule();
  await noteStateIntegrity(ctx.cfg, ctx.prompter, ctx.configPath);
}

async function runCodexSessionRouteHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairCodexSessionRoutes } =
    await import("../commands/doctor/shared/codex-route-warnings.js");
  const { note } = await loadNoteModule();
  const result = await maybeRepairCodexSessionRoutes({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

async function runSessionLocksHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionLockHealth } = await import("../commands/doctor-session-locks.js");
  await noteSessionLockHealth({
    shouldRepair: ctx.prompter.shouldRepair,
    config: ctx.cfg,
    env: ctx.env,
  });
}

async function runSessionTranscriptsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionTranscriptHealth } = await import("../commands/doctor-session-transcripts.js");
  await noteSessionTranscriptHealth({ shouldRepair: ctx.prompter.shouldRepair });
}

async function runSessionSnapshotsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteSessionSnapshotHealth } = await import("../commands/doctor-session-snapshots.js");
  await noteSessionSnapshotHealth({
    cfg: ctx.cfg,
    env: ctx.env ?? process.env,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

async function runConfigAuditScrubHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeScrubConfigAuditLog } = await import("../commands/doctor-config-audit-scrub.js");
  await maybeScrubConfigAuditLog({ shouldRepair: ctx.prompter.shouldRepair });
}

async function runLegacyCronHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairLegacyCronStore, noteLegacyWhatsAppCrontabHealthCheck } =
    await import("../commands/doctor/cron/index.js");
  await noteLegacyWhatsAppCrontabHealthCheck();
  await maybeRepairLegacyCronStore({
    cfg: ctx.cfg,
    options: ctx.options,
    prompter: ctx.prompter,
  });
}

async function runSandboxHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairSandboxImages, maybeRepairSandboxRegistryFiles, noteSandboxScopeWarnings } =
    await import("../commands/doctor-sandbox.js");
  await maybeRepairSandboxRegistryFiles(ctx.prompter);
  ctx.cfg = await maybeRepairSandboxImages(ctx.cfg, ctx.runtime, ctx.prompter);
  noteSandboxScopeWarnings(ctx.cfg);
}

async function runGatewayServicesHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairGatewayServiceConfig, maybeScanExtraGatewayServices } =
    await import("../commands/doctor-gateway-services.js");
  const {
    noteMacLaunchAgentOverrides,
    noteMacLaunchctlGatewayEnvOverrides,
    noteMacStaleOpenClawUpdateLaunchdJobs,
  } = await import("../commands/doctor-platform-notes.js");
  await maybeScanExtraGatewayServices(ctx.options, ctx.runtime, ctx.prompter);
  await maybeRepairGatewayServiceConfig(
    ctx.cfg,
    resolveDoctorMode(ctx.cfg),
    ctx.runtime,
    ctx.prompter,
    { allowExecSecretRefs: ctx.options.allowExec === true },
  );
  await noteMacLaunchAgentOverrides();
  await noteMacStaleOpenClawUpdateLaunchdJobs();
  await noteMacLaunchctlGatewayEnvOverrides(ctx.cfg);
}

async function runStartupChannelMaintenanceHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRunDoctorStartupChannelMaintenance } =
    await import("./doctor-startup-channel-maintenance.js");
  await maybeRunDoctorStartupChannelMaintenance({
    cfg: ctx.cfg,
    env: process.env,
    runtime: ctx.runtime,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

async function runSecurityHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteInstallPolicyHealth } = await import("../commands/doctor-install-policy.js");
  const { noteSecurityWarnings } = await import("../commands/doctor-security.js");
  await noteSecurityWarnings(ctx.cfg);
  await noteInstallPolicyHealth(ctx.cfg, { deep: ctx.options.deep === true, env: ctx.env });
}

async function runBrowserHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteChromeMcpBrowserReadiness } = await import("../commands/doctor-browser.js");
  await runCoreContributionHealthRepair(ctx, ["core/doctor/browser-clawd-profile-residue"]);
  await noteChromeMcpBrowserReadiness(ctx.cfg);
}

async function runOpenAIOAuthTlsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteOpenAIOAuthTlsPrerequisites } =
    await import("../plugins/provider-openai-chatgpt-oauth-tls.js");
  await noteOpenAIOAuthTlsPrerequisites({
    cfg: ctx.cfg,
    deep: ctx.options.deep === true,
  });
}

async function runHooksModelHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (!ctx.cfg.hooks?.gmail?.model?.trim()) {
    return;
  }
  const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await loadAgentDefaultsModule();
  const { loadModelCatalog } = await loadModelCatalogModule();
  const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
    await loadModelSelectionModule();
  const { note } = await loadNoteModule();
  const hooksModelRef = resolveHooksGmailModel({
    cfg: ctx.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  if (!hooksModelRef) {
    note(`- hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved`, "Hooks");
    return;
  }
  const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
    cfg: ctx.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const catalog = await loadModelCatalog({ config: ctx.cfg, readOnly: true });
  const status = getModelRefStatus({
    cfg: ctx.cfg,
    catalog,
    ref: hooksModelRef,
    defaultProvider,
    defaultModel,
  });
  const warnings: string[] = [];
  if (!status.allowed) {
    warnings.push(
      `- hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
    );
  }
  if (!status.inCatalog) {
    warnings.push(
      `- hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
    );
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Hooks");
  }
}

async function runToolResultCapHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { resolveAgentContextLimits } = await loadAgentScopeModule();
  const { normalizeAgentId } = await import("../routing/session-key.js");
  const targets: Array<{
    agentId?: string;
    configuredCap?: number;
    scopeLabel: string;
  }> = [];
  const defaultsConfiguredCap = ctx.cfg.agents?.defaults?.contextLimits?.toolResultMaxChars;
  if (ctx.options.deep === true || defaultsConfiguredCap !== undefined) {
    targets.push({
      configuredCap: defaultsConfiguredCap,
      scopeLabel: "defaults",
    });
  }
  for (const entry of ctx.cfg.agents?.list ?? []) {
    const normalizedAgentId = normalizeAgentId(entry.id);
    if (
      !normalizedAgentId ||
      (ctx.options.deep !== true &&
        defaultsConfiguredCap === undefined &&
        entry.contextLimits?.toolResultMaxChars === undefined)
    ) {
      continue;
    }
    targets.push({
      agentId: normalizedAgentId,
      configuredCap: resolveAgentContextLimits(ctx.cfg, normalizedAgentId)?.toolResultMaxChars,
      scopeLabel: `agent "${normalizedAgentId}"`,
    });
  }
  if (targets.length === 0) {
    return;
  }

  const { DEFAULT_CONTEXT_TOKENS } = await loadAgentDefaultsModule();
  const { loadModelCatalog, findModelCatalogEntry } = await loadModelCatalogModule();
  const { resolveContextWindowInfo } = await import("../agents/context-window-guard.js");
  const { resolveDefaultModelForAgent, modelKey } = await loadModelSelectionModule();
  const { buildToolResultCapDoctorAdvice } = await import("./doctor-tool-result-cap-advice.js");
  const { note } = await loadNoteModule();

  const catalog = await loadModelCatalog({ config: ctx.cfg });
  const lines = targets.flatMap((target) => {
    const modelRef = resolveDefaultModelForAgent({
      cfg: ctx.cfg,
      agentId: target.agentId,
    });
    const entry = findModelCatalogEntry(catalog, {
      provider: modelRef.provider,
      modelId: modelRef.model,
    });
    const contextWindow = resolveContextWindowInfo({
      cfg: ctx.cfg,
      provider: modelRef.provider,
      modelId: modelRef.model,
      modelContextTokens: entry?.contextTokens,
      modelContextWindow: entry?.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    return buildToolResultCapDoctorAdvice({
      contextWindowTokens: contextWindow.tokens,
      modelKey: modelKey(modelRef.provider, modelRef.model),
      configuredCap: target.configuredCap,
      deep: ctx.options.deep === true,
      scopeLabel: target.scopeLabel,
    });
  });
  if (lines.length > 0) {
    note(lines.join("\n"), "Tool result cap");
  }
}

async function runSystemdLingerHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (
    ctx.options.nonInteractive === true ||
    process.platform !== "linux" ||
    resolveDoctorMode(ctx.cfg) !== "local"
  ) {
    return;
  }
  const { resolveGatewayService } = await import("../daemon/service.js");
  const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
  const { note } = await loadNoteModule();
  const service = resolveGatewayService();
  let loaded;
  try {
    loaded = await service.isLoaded({ env: process.env });
  } catch {
    loaded = false;
  }
  if (!loaded) {
    return;
  }
  await ensureSystemdUserLingerInteractive({
    runtime: ctx.runtime,
    prompter: {
      confirm: async (p) => ctx.prompter.confirm(p),
      note,
    },
    reason:
      "Gateway runs as a systemd user service. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
    requireConfirm: true,
  });
}

async function hasActiveGatewayExecCredential(
  ctx: DoctorHealthFlowContext,
  mode: DoctorFlowMode = resolveDoctorMode(ctx.cfg),
): Promise<boolean> {
  const { resolveSecretInputRef } = await loadSecretTypesModule();
  const { gatewaySecretInputPathCanWin } = await import("../gateway/credentials-secret-inputs.js");
  const { ALL_GATEWAY_SECRET_INPUT_PATHS, readGatewaySecretInputValue } =
    await import("../gateway/secret-input-paths.js");
  return ALL_GATEWAY_SECRET_INPUT_PATHS.some((path) => {
    if (
      !gatewaySecretInputPathCanWin({
        config: ctx.cfg,
        env: process.env,
        modeOverride: mode,
        path,
      })
    ) {
      return false;
    }
    const ref = resolveSecretInputRef({
      value: readGatewaySecretInputValue(ctx.cfg, path),
      defaults: ctx.cfg.secrets?.defaults,
    }).ref;
    return ref?.source === "exec";
  });
}

async function runWorkspaceStatusHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  let pluginVersionDrift:
    | import("../plugins/plugin-version-drift.js").PluginVersionDriftReport
    | undefined;
  if (ctx.cfg.gateway?.mode !== "remote") {
    try {
      const { gatherDaemonStatus } = await import("../cli/daemon-cli/status.gather.js");
      const allowExecSecretRefs = ctx.options.allowExec === true;
      const status = await gatherDaemonStatus({
        rpc: {
          timeout: ctx.options.nonInteractive === true ? "3000" : "10000",
          json: true,
        },
        probe: true,
        requireRpc: false,
        deep: ctx.options.deep === true,
        allowExecSecretRefs,
      });
      const hasProbedGatewayVersion =
        typeof status.gateway?.version === "string" && status.gateway.version.trim() !== "";
      if (status.pluginVersionDrift && hasProbedGatewayVersion && !status.rpc?.authWarning) {
        pluginVersionDrift = status.pluginVersionDrift;
      }
    } catch {
      // Best-effort diagnostic: doctor should keep running if daemon status is unavailable.
    }
  }
  const { noteWorkspaceStatus } = await import("../commands/doctor-workspace-status.js");
  noteWorkspaceStatus(ctx.cfg, { pluginVersionDrift });
}

async function runSkillsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairSkillReadiness } = await import("../commands/doctor-skills.js");
  ctx.cfg = await maybeRepairSkillReadiness({
    cfg: ctx.cfg,
    prompter: ctx.prompter,
  });
}

async function runBootstrapSizeHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteBootstrapFileSize } = await import("../commands/doctor-bootstrap-size.js");
  await noteBootstrapFileSize(ctx.cfg);
}

async function runHeartbeatTemplateRepairHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairHeartbeatTemplate } =
    await import("../commands/doctor-heartbeat-template-repair.js");
  await maybeRepairHeartbeatTemplate({
    cfg: ctx.cfg,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

async function runShellCompletionHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { doctorShellCompletion } = await import("../commands/doctor-completion.js");
  await doctorShellCompletion(ctx.runtime, ctx.prompter, {
    nonInteractive: ctx.options.nonInteractive,
  });
}

async function runGatewayHealthChecks(ctx: DoctorHealthFlowContext): Promise<void> {
  const { note } = await loadNoteModule();
  if ((await hasActiveGatewayExecCredential(ctx)) && ctx.options.allowExec !== true) {
    note(
      "Gateway health probes skipped because gateway credentials use an exec SecretRef. Run `openclaw doctor --allow-exec` to verify Gateway health with exec SecretRefs.",
      "Gateway",
    );
    ctx.gatewayHealthSkipped = true;
    ctx.gatewayMemoryProbe = { checked: false, ready: false, skipped: true };
    return;
  }
  const { checkGatewayHealth, probeGatewayMemoryStatus } =
    await import("../commands/doctor-gateway-health.js");
  const { healthOk, authenticated, status } = await checkGatewayHealth({
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    timeoutMs: ctx.options.nonInteractive === true ? 3000 : 10_000,
  });
  ctx.gatewayHealthSkipped = false;
  ctx.healthOk = healthOk;
  ctx.gatewayHealthAuthenticated = authenticated;
  ctx.gatewayStatus = status;
  ctx.gatewayMemoryProbe = authenticated
    ? await probeGatewayMemoryStatus({
        cfg: ctx.cfg,
        timeoutMs: ctx.options.nonInteractive === true ? 3000 : 10_000,
      })
    : { checked: false, ready: false, skipped: healthOk };
}

async function runWhatsappResponsivenessHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteWhatsappResponsivenessHealth } =
    await import("../commands/doctor-whatsapp-responsiveness.js");
  await noteWhatsappResponsivenessHealth({
    cfg: ctx.cfg,
    status: ctx.gatewayStatus,
    shouldRepair: ctx.prompter.shouldRepair,
  });
}

async function runMemorySearchHealthContribution(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth, noteMemorySearchHealth } =
    await import("../commands/doctor-memory-search.js");
  if (ctx.prompter.shouldRepair) {
    await maybeRepairMemoryRecallHealth({
      cfg: ctx.cfg,
      prompter: ctx.prompter,
    });
  }
  await noteMemorySearchHealth(ctx.cfg, {
    gatewayMemoryProbe: ctx.gatewayMemoryProbe ?? { checked: false, ready: false, skipped: false },
  });
  if (ctx.options.deep === true) {
    await noteMemoryRecallHealth(ctx.cfg);
  }
}

async function runDevicePairingHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { noteDevicePairingHealth } = await import("../commands/doctor-device-pairing.js");
  await noteDevicePairingHealth({
    cfg: ctx.cfg,
    healthOk: ctx.healthOk ?? false,
  });
}

async function runGatewayDaemonHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { maybeRepairGatewayDaemon } = await import("../commands/doctor-gateway-daemon-flow.js");
  await maybeRepairGatewayDaemon({
    cfg: ctx.cfg,
    runtime: ctx.runtime,
    prompter: ctx.prompter,
    options: ctx.options,
    gatewayDetailsMessage: ctx.gatewayDetails?.message ?? "",
    // A skipped exec-backed token probe is unknown, not unhealthy. Do not let
    // doctor --fix restart services only because probing would require exec.
    healthOk: ctx.healthOk ?? false,
    healthSkipped: ctx.gatewayHealthSkipped === true,
  });
}

async function runWriteConfigHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { formatCliCommand } = await loadCommandFormatModule();
  const { applyWizardMetadata } = await loadOnboardHelpersModule();
  const { replaceConfigFile } = await loadConfigModule();
  const { logConfigUpdated } = await import("../config/logging.js");
  const { shortenHomePath } = await import("../utils.js");
  const shouldWriteConfig =
    ctx.configResult.shouldWriteConfig ||
    JSON.stringify(ctx.cfg) !== JSON.stringify(ctx.cfgForPersistence);
  if (shouldWriteConfig) {
    const updateDoctorRun = isUpdateDoctorRun(ctx.env ?? process.env);
    ctx.cfg = applyWizardMetadata(ctx.cfg, {
      command: "doctor",
      mode: resolveDoctorMode(ctx.cfg),
    });
    if (shouldSkipLegacyUpdateDoctorConfigWrite({ env: ctx.env ?? process.env })) {
      ctx.runtime.log("Skipping doctor config write during legacy update handoff.");
      return;
    }
    const legacyParentVersionOverride = isLegacyParentWritableUpdateDoctorPass(
      ctx.env ?? process.env,
    )
      ? ctx.configResult.sourceLastTouchedVersion?.trim() || ctx.cfg.meta?.lastTouchedVersion
      : undefined;
    await replaceConfigFile({
      nextConfig: ctx.cfg,
      afterWrite: { mode: "auto" },
      writeOptions: {
        allowConfigSizeDrop: ctx.configResult.shouldWriteConfig === true || updateDoctorRun,
        skipPluginValidation:
          ctx.configResult.skipPluginValidationOnWrite === true || updateDoctorRun,
        preservedLegacyRootKeys: ctx.configResult.preservedLegacyRootKeys,
        ...(legacyParentVersionOverride
          ? { lastTouchedVersionOverride: legacyParentVersionOverride }
          : {}),
      },
    });
    logConfigUpdated(ctx.runtime);
    const preUpdateSnapshotPath = `${ctx.configPath}.pre-update`;
    if (updateDoctorRun && fs.existsSync(preUpdateSnapshotPath)) {
      ctx.runtime.log(
        `Update changed config; pre-update backup: ${shortenHomePath(preUpdateSnapshotPath)}`,
      );
    }
    const backupPath = `${ctx.configPath}.bak`;
    if (fs.existsSync(backupPath)) {
      ctx.runtime.log(`Backup: ${shortenHomePath(backupPath)}`);
    }
    return;
  }
  if (!ctx.prompter.shouldRepair) {
    ctx.runtime.log(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply changes.`);
  }
}

async function runWorkspaceSuggestionsHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  if (ctx.options.workspaceSuggestions === false) {
    return;
  }
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await loadAgentScopeModule();
  const { noteWorkspaceBackupTip } = await loadDoctorStateIntegrityModule();
  const { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } =
    await import("../commands/doctor-workspace.js");
  const { note } = await loadNoteModule();
  const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
  noteWorkspaceBackupTip(workspaceDir);
  if (await shouldSuggestMemorySystem(workspaceDir)) {
    note(MEMORY_SYSTEM_PROMPT, "Workspace");
  }
}

async function runFinalConfigValidationHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { readConfigFileSnapshot } = await loadConfigModule();
  const finalSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: isUpdateDoctorRun(ctx.env ?? process.env),
    preservedLegacyRootKeys: ctx.configResult.preservedLegacyRootKeys,
  });
  if (finalSnapshot.exists && !finalSnapshot.valid) {
    ctx.runtime.error("Invalid config:");
    for (const issue of finalSnapshot.issues) {
      const path = issue.path || "<root>";
      ctx.runtime.error(`- ${path}: ${issue.message}`);
    }
  }
}

function formatHealthFindings(findings: readonly HealthFinding[]): string {
  return findings
    .map((finding) => {
      const lines = [`- ${finding.message}`];
      if (finding.path) {
        lines.push(`  path: ${finding.path}`);
      }
      if (finding.requirement) {
        lines.push(`  issue: ${finding.requirement}`);
      }
      if (finding.fixHint) {
        lines.push(`  fix: ${finding.fixHint}`);
      }
      return lines.join("\n");
    })
    .join("\n");
}

async function runProviderCatalogProjectionHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { registerCoreHealthChecks } = await loadDoctorCoreChecksModule();
  const { getHealthCheck } = await loadHealthCheckRegistryModule();
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await loadAgentScopeModule();
  const { note } = await loadNoteModule();

  registerCoreHealthChecks();
  const check = getHealthCheck("core/doctor/provider-catalog-projection");
  if (!check) {
    return;
  }
  const findings = await check.detect({
    mode: "doctor",
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    cwd: resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg)),
    configPath: ctx.configPath,
  });
  if (findings.length === 0) {
    return;
  }
  ctx.healthOk = false;
  note(formatHealthFindings(findings), "Doctor warnings");
}

async function runRuntimeToolSchemasHealth(ctx: DoctorHealthFlowContext): Promise<void> {
  const { registerCoreHealthChecks } = await loadDoctorCoreChecksModule();
  const { getHealthCheck } = await loadHealthCheckRegistryModule();
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } = await loadAgentScopeModule();
  const { note } = await loadNoteModule();

  registerCoreHealthChecks();
  const check = getHealthCheck("core/doctor/runtime-tool-schemas");
  if (!check) {
    return;
  }
  const findings = await check.detect({
    mode: "doctor",
    runtime: ctx.runtime,
    cfg: ctx.cfg,
    cwd: resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg)),
    configPath: ctx.configPath,
  });
  if (findings.length === 0) {
    return;
  }
  ctx.healthOk = false;
  note(formatHealthFindings(findings), "Doctor warnings");
}

export function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution({
      id: "doctor:gateway-config",
      label: "Gateway config",
      healthCheckIds: ["core/doctor/gateway-config"],
      run: runGatewayConfigHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:auth-profiles",
      label: "Auth profiles",
      run: runAuthProfileHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:claude-cli",
      label: "Claude CLI",
      healthCheckIds: ["core/doctor/claude-cli"],
      run: runClaudeCliHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-auth",
      label: "Gateway auth",
      healthCheckIds: ["core/doctor/gateway-auth"],
      run: runGatewayAuthHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:command-owner",
      label: "Command owner",
      healthCheckIds: ["core/doctor/command-owner"],
      run: runCommandOwnerHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:structured-health-repairs",
      label: "Structured health repairs",
      run: runStructuredHealthRepairs,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-state",
      label: "Legacy state",
      healthCheckIds: ["core/doctor/legacy-state"],
      run: runLegacyStateHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-plugin-manifests",
      label: "Legacy plugin manifests",
      run: runLegacyPluginManifestHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:release-configured-plugin-installs",
      label: "Configured plugin repair",
      run: runReleaseConfiguredPluginInstallsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:plugin-registry",
      label: "Plugin registry",
      run: runPluginRegistryHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:ui-protocol-freshness",
      label: "UI protocol freshness",
      healthCheckIds: ["core/doctor/ui-protocol-freshness"],
      run: async () => {},
    }),
    createDoctorHealthContribution({
      id: "doctor:disk-space",
      label: "Disk space",
      run: runDiskSpaceHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:state-integrity",
      label: "State integrity",
      run: runStateIntegrityHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:codex-session-routes",
      label: "Codex session routes",
      healthCheckIds: ["core/doctor/codex-session-routes"],
      run: runCodexSessionRouteHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-locks",
      label: "Session locks",
      run: runSessionLocksHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-transcripts",
      label: "Session transcripts",
      run: runSessionTranscriptsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-snapshots",
      label: "Session snapshots",
      run: runSessionSnapshotsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:config-audit-scrub",
      label: "Config audit",
      run: runConfigAuditScrubHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-cron",
      label: "Legacy cron",
      healthCheckIds: ["core/doctor/legacy-whatsapp-crontab"],
      run: runLegacyCronHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:sandbox",
      label: "Sandbox",
      healthChecks: {
        id: "core/doctor/sandbox/registry-files",
        description: "Legacy sandbox registry files are represented in SQLite registry storage.",
        async detect() {
          const {
            detectLegacySandboxRegistryFileIssues,
            legacySandboxRegistryInspectionToHealthFinding,
          } = await import("../commands/doctor-sandbox.js");
          return (await detectLegacySandboxRegistryFileIssues()).map(
            legacySandboxRegistryInspectionToHealthFinding,
          );
        },
        async repair(ctx) {
          const {
            detectLegacySandboxRegistryFileIssues,
            legacySandboxRegistryInspectionToRepairEffect,
          } = await import("../commands/doctor-sandbox.js");
          const effects = (await detectLegacySandboxRegistryFileIssues()).map(
            legacySandboxRegistryInspectionToRepairEffect,
          );
          if (ctx.dryRun === true) {
            return { status: "repaired", changes: [], effects };
          }
          return {
            status: "skipped",
            reason: "legacy doctor sandbox contribution owns registry migration",
            changes: [],
            effects,
          };
        },
      },
      run: runSandboxHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-services",
      label: "Gateway services",
      healthCheckIds: [
        "core/doctor/gateway-services/extra",
        "core/doctor/gateway-services/platform-notes",
      ],
      run: runGatewayServicesHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:startup-channel-maintenance",
      label: "Startup channel maintenance",
      run: runStartupChannelMaintenanceHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:security",
      label: "Security",
      healthCheckIds: ["core/doctor/security"],
      run: runSecurityHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:browser",
      label: "Browser",
      healthCheckIds: ["core/doctor/browser", "core/doctor/browser-clawd-profile-residue"],
      run: runBrowserHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:oauth-tls",
      label: "OAuth TLS",
      healthCheckIds: ["core/doctor/oauth-tls"],
      run: runOpenAIOAuthTlsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:hooks-model",
      label: "Hooks model",
      healthCheckIds: ["core/doctor/hooks-model"],
      run: runHooksModelHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:tool-result-cap",
      label: "Tool result cap",
      run: runToolResultCapHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:provider-catalog-projection",
      label: "Provider catalog projection",
      healthCheckIds: ["core/doctor/provider-catalog-projection"],
      run: runProviderCatalogProjectionHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:runtime-tool-schemas",
      label: "Runtime tool schemas",
      healthCheckIds: ["core/doctor/runtime-tool-schemas"],
      run: runRuntimeToolSchemasHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:systemd-linger",
      label: "systemd linger",
      run: runSystemdLingerHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:workspace-status",
      label: "Workspace status",
      run: runWorkspaceStatusHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:skills",
      label: "Skills",
      healthCheckIds: ["core/doctor/skills-readiness"],
      run: runSkillsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:bootstrap-size",
      label: "Bootstrap size",
      healthCheckIds: ["core/doctor/bootstrap-size"],
      run: runBootstrapSizeHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:heartbeat-template-repair",
      label: "Heartbeat template repair",
      run: runHeartbeatTemplateRepairHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:shell-completion",
      label: "Shell completion",
      healthCheckIds: ["core/doctor/shell-completion"],
      run: runShellCompletionHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-health",
      label: "Gateway health",
      run: runGatewayHealthChecks,
    }),
    createDoctorHealthContribution({
      id: "doctor:whatsapp-responsiveness",
      label: "WhatsApp responsiveness",
      run: runWhatsappResponsivenessHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:memory-search",
      label: "Memory search",
      run: runMemorySearchHealthContribution,
    }),
    createDoctorHealthContribution({
      id: "doctor:device-pairing",
      label: "Device pairing",
      run: runDevicePairingHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-daemon",
      label: "Gateway daemon",
      run: runGatewayDaemonHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:write-config",
      label: "Write config",
      run: runWriteConfigHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:workspace-suggestions",
      label: "Workspace suggestions",
      healthCheckIds: ["core/doctor/workspace-suggestions"],
      run: runWorkspaceSuggestionsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:final-config-validation",
      label: "Final config validation",
      healthCheckIds: ["core/doctor/final-config-validation"],
      run: runFinalConfigValidationHealth,
    }),
  ];
}

export async function resolveDoctorContributionHealthChecks(): Promise<readonly HealthCheck[]> {
  const { CORE_HEALTH_CHECKS } = await import("./doctor-core-checks.js");
  const checksById = new Map(CORE_HEALTH_CHECKS.map((check) => [check.id, check]));
  const checks: HealthCheck[] = [];
  for (const contribution of resolveDoctorHealthContributions()) {
    if (contribution.healthChecks.length > 0) {
      checks.push(...contribution.healthChecks.map(normalizeHealthCheck));
      continue;
    }
    for (const id of contribution.healthCheckIds) {
      const check = checksById.get(id);
      if (check === undefined) {
        throw new Error(
          `doctor contribution ${contribution.id} references unknown core health check ${id}`,
        );
      }
      checks.push(check);
    }
  }
  return checks;
}

export async function runDoctorHealthContributions(ctx: DoctorHealthFlowContext): Promise<void> {
  for (const contribution of resolveDoctorHealthContributions()) {
    await contribution.run(ctx);
  }
}
