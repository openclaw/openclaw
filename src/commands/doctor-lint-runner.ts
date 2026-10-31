import { isDeepStrictEqual } from "node:util";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  createConfigIO,
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/config.js";
import { maybeLoadDotEnvForConfig } from "../config/io.runtime-env.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { loadPinnedRuntimeConfigAsync } from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import { configValidationIssuesToHealthFindings } from "../flows/doctor-config-validation-findings.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { DoctorHealthCheckContext } from "../flows/doctor-health-contribution-types.js";
import {
  stateSchemaHealthCheck,
  exitCodeFromFindings,
  runDoctorLintChecks,
  selectUpdateReadinessChecks,
  type DoctorLintRunOptions,
} from "../flows/doctor-lint-flow.js";
import {
  admitDoctorUpdateInspection,
  resolveDoctorUpdateBudget,
} from "../flows/doctor-update-budget.js";
import { listExtensionHealthChecksForDoctor } from "../flows/health-check-registry.js";
import type { DoctorHealthCheck } from "../flows/health-check-runner-types.js";
import {
  healthFindingMeetsSeverity,
  isHealthCheckEnabledByDefault,
  parseHealthFindingSeverity,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "../flows/health-checks.js";
import {
  readDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { SqliteSnapshotCleanupError } from "../infra/sqlite-readonly-location-cleanup.js";
import { UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX } from "../infra/update-doctor-lint.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  resolveLegacyHeartbeatAgents,
  tryProjectRetiredHeartbeatConfig,
} from "./doctor-heartbeat-legacy.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import {
  createDeferredInspectionExecution,
  createStateSnapshotFailureExecution,
  createStateSnapshotFailureFinding,
  detectDoctorLintOutputMode,
  writeJsonResult,
  type DoctorLintExecution,
} from "./doctor-lint-output.js";
import {
  DoctorLintStateSnapshotError,
  recordSnapshotCleanupWarning,
  withDoctorLintStateEnv,
  withReadOnlyPluginStateSnapshot,
  type DoctorLintPluginStateRunner,
} from "./doctor-lint-state-snapshot.js";
import { isPostCoreConvergencePass, isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";
import { collectRecoveryDiskUsage, formatRecoveryDiskUsage } from "./recovery-disk-usage.js";

type DoctorLintStateView = {
  coreChecks?: readonly DoctorHealthCheck[];
  deferredCheckIds?: ReadonlySet<string>;
  deferInspectionDisposal?: DoctorHealthCheckContext["deferInspectionDisposal"];
  cleanupWarnings?: HealthFinding[];
  pluginMetadataEnv: NodeJS.ProcessEnv;
  readConfigSnapshot: () => ReturnType<typeof readConfigFileSnapshot>;
  sourceEnv: NodeJS.ProcessEnv;
  runWithPluginStateSnapshot: DoctorLintPluginStateRunner;
};

type DoctorLintStateRunner = <T>(run: () => Promise<T>) => Promise<T>;

const RUNTIME_TOOL_SCHEMA_CHECK_ID = "core/doctor/runtime-tool-schemas";
const PROJECT_CLONE_SHAPE_CHECK_ID = "core/doctor/project-clone-shape";
const SKILLS_READINESS_CHECK_ID = "core/doctor/skills-readiness";
const AUTH_PROFILE_CHECK_ID = "core/doctor/auth-profiles";
const HEARTBEAT_SOURCE_CHECK_IDS = new Set([
  "core/doctor/heartbeat-cadence-migration",
  "core/doctor/heartbeat-scratch-migration",
]);

/** Only the rehearsal worker reports before disposal and inherits its CLI's budget anchor. */
export async function runDoctorLintCliInProcess(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  worker?: { commandStartedAtMs?: number },
): Promise<number> {
  let reported: DoctorLintExecution | undefined;
  const report = (execution: DoctorLintExecution) => {
    execution.writeOutput();
    reported = execution;
  };
  try {
    const execution = await withArtifactPreservingStateReads(
      () =>
        prepareDoctorLintExecution(
          runtime,
          opts,
          worker ? report : undefined,
          worker?.commandStartedAtMs,
        ),
      { agentDatabases: true },
    );
    if (!reported) {
      report(execution);
    } else {
      for (const warning of execution.cleanupWarnings ?? []) {
        runtime.error(`${UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX}: ${warning.message}`);
      }
    }
    return execution.exitCode;
  } catch (error) {
    if (!reported) {
      throw error;
    }
    runtime.error(`${UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX}: ${scrubDoctorErrorMessage(error)}`);
    return reported.exitCode;
  }
}

/** Collect advisory doctor findings without writing output or repairing operator state. */
export async function collectDoctorFindings(
  runtime: RuntimeEnv,
): Promise<readonly HealthFinding[]> {
  const execution = await withArtifactPreservingStateReads(
    () => prepareDoctorLintExecution(runtime, { severityMin: "info" }),
    { agentDatabases: true },
  );
  return execution.findings;
}

async function prepareDoctorLintExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  onChecksComplete?: (execution: DoctorLintExecution) => void,
  commandStartedAtMs?: number,
): Promise<DoctorLintExecution> {
  const sevMin =
    opts.severityMin === undefined ? "warning" : parseHealthFindingSeverity(opts.severityMin);
  if (sevMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  maybeLoadDotEnvForConfig(process.env);
  const sourceEnv = { ...process.env };
  if (resolveUpdateRehearsalRoot(sourceEnv) && !opts.onlyIds?.length) {
    // The preceding repair and following config/plugin/startup gates own required
    // admission. Lint is advisory inspection; admit it before plugin registration
    // or private inspection snapshots consume the old driver's shared budget.
    const snapshot = await createConfigIO({
      env: sourceEnv,
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    if (snapshot.valid) {
      const budget = await resolveDoctorUpdateBudget({
        cfg: snapshot.config,
        env: sourceEnv,
        commandStartedAtMs,
      });
      if (
        budget &&
        !admitDoctorUpdateInspection(budget, "agent", [
          { id: "core/doctor/lint-inspection", label: "Doctor lint inspection" },
        ])
      ) {
        return createDeferredInspectionExecution(runtime, opts, [...budget.deferred.values()]);
      }
    }
  }
  const cleanupWarnings: HealthFinding[] | undefined = isUpdateDoctorLintPass(sourceEnv)
    ? []
    : undefined;
  const runStateChecks = async (): Promise<DoctorLintExecution> => {
    const updateReadiness = isPostCoreConvergencePass(sourceEnv) ? "post-plugin" : undefined;
    const effectiveOpts: DoctorLintCliOptions = updateReadiness
      ? { ...opts, updateReadiness }
      : opts;
    const { resolveBundledHealthCheckPluginStateMode } =
      await import("../flows/bundled-health-checks.js");
    const pluginStateMode = resolveBundledHealthCheckPluginStateMode(effectiveOpts);
    let coreChecks: readonly DoctorHealthCheck[] | undefined;
    const deferredCheckIds = new Set<string>();
    if (resolveUpdateRehearsalRoot(sourceEnv) && !updateReadiness && !opts.onlyIds?.length) {
      const { resolveDoctorContributionHealthChecks } =
        await import("../flows/doctor-health-contributions.js");
      coreChecks = await resolveDoctorContributionHealthChecks();
      for (const check of coreChecks) {
        if (
          (check.updateWork?.kind === "inspection" || check.updateWork?.kind === "standalone") &&
          (opts.includeAllChecks === true || isHealthCheckEnabledByDefault(check)) &&
          !opts.skipIds?.includes(check.id)
        ) {
          deferredCheckIds.add(check.id);
        }
      }
    }
    // The copied repair and readiness gates do not need optional agent tool projections.
    const prepareRuntimeValidation =
      !deferredCheckIds.has(RUNTIME_TOOL_SCHEMA_CHECK_ID) &&
      (pluginStateMode === "isolated" ||
        !effectiveOpts.onlyIds?.length ||
        effectiveOpts.onlyIds.includes(RUNTIME_TOOL_SCHEMA_CHECK_ID));
    const readConfigSnapshot = async (
      deferredPluginMigrations?: readonly DeferredPluginMigration[],
    ) => {
      const io =
        pluginStateMode === "direct"
          ? { readConfigFileSnapshot, readConfigFileSnapshotWithPluginMetadata }
          : createConfigIO({
              env: sourceEnv,
              configPath: resolveConfigPath(sourceEnv, resolveStateDir(sourceEnv)),
              observe: false,
              pluginValidation: pluginStateMode === "deferred" ? "core-only" : undefined,
              deferredPluginMigrations,
            });
      return pluginStateMode === "deferred" || !prepareRuntimeValidation
        ? io.readConfigFileSnapshot({ observe: false })
        : (
            await io.readConfigFileSnapshotWithPluginMetadata({
              observe: false,
              prepareValidation: "runtime",
            })
          ).snapshot;
    };
    let checksReported = false;
    let completedExecution: DoctorLintExecution | undefined;
    try {
      return await withReadOnlyPluginStateSnapshot(
        sourceEnv,
        async (runWithPluginStateSnapshot) => {
          const stateView: DoctorLintStateView = {
            coreChecks,
            deferredCheckIds,
            cleanupWarnings,
            pluginMetadataEnv: sourceEnv,
            sourceEnv,
            readConfigSnapshot,
            runWithPluginStateSnapshot,
          };
          if (pluginStateMode !== "isolated" && !onChecksComplete) {
            return (completedExecution = await executeDoctorLint(
              runtime,
              effectiveOpts,
              sevMin,
              stateView,
            ));
          }
          return await stateView.runWithPluginStateSnapshot(async (pluginMetadataEnv) => {
            const pending = readDeferredPluginMigrations({ env: pluginMetadataEnv });
            const disposals: Array<() => Promise<void>> = [];
            try {
              const execution = await executeDoctorLint(runtime, effectiveOpts, sevMin, {
                ...stateView,
                pluginMetadataEnv,
                readConfigSnapshot: () => readConfigSnapshot(pending),
                runWithPluginStateSnapshot: async (run) => run(pluginMetadataEnv),
                deferInspectionDisposal: onChecksComplete
                  ? (dispose) => disposals.push(dispose)
                  : undefined,
              });
              completedExecution = execution;
              onChecksComplete?.(execution);
              checksReported = onChecksComplete !== undefined;
              return execution;
            } finally {
              // This join stays inside the private state/env scope, including when output fails.
              for (const dispose of disposals) {
                try {
                  await dispose();
                } catch (error) {
                  runtime.error(
                    `${UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX}: ${scrubDoctorErrorMessage(error)}`,
                  );
                }
              }
            }
          });
        },
        cleanupWarnings,
      );
    } catch (error) {
      if (checksReported || !(error instanceof DoctorLintStateSnapshotError)) {
        throw error;
      }
      return createStateSnapshotFailureExecution(
        runtime,
        effectiveOpts,
        sevMin,
        error,
        completedExecution,
      );
    }
  };
  let snapshotExecution: DoctorLintExecution | undefined;
  try {
    return await withOpenClawStateDatabaseReadSnapshot(
      async () => (snapshotExecution = await runStateChecks()),
      {
        env: sourceEnv,
        lazy: Boolean(opts.onlyIds?.length),
      },
    );
  } catch (error) {
    if (!snapshotExecution || !cleanupWarnings || !(error instanceof SqliteSnapshotCleanupError)) {
      throw error;
    }
    recordSnapshotCleanupWarning(cleanupWarnings);
    return snapshotExecution;
  }
}

async function executeDoctorLint(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  sevMin: NonNullable<ReturnType<typeof parseHealthFindingSeverity>>,
  stateView: DoctorLintStateView,
): Promise<DoctorLintExecution> {
  const snapshot = await stateView.readConfigSnapshot();
  const projectedHeartbeatConfig =
    snapshot.exists && !snapshot.valid
      ? tryProjectRetiredHeartbeatConfig(snapshot.sourceConfig)
      : undefined;
  const admittedHeartbeatConfig =
    projectedHeartbeatConfig &&
    (resolveLegacyHeartbeatAgents(snapshot.sourceConfig).some(
      (agent) => agent.heartbeat !== undefined,
    ) ||
      !isDeepStrictEqual(snapshot.sourceConfig.channels, projectedHeartbeatConfig.channels))
      ? projectedHeartbeatConfig
      : undefined;
  const projectedHeartbeatValidation = admittedHeartbeatConfig
    ? validateConfigObjectWithPlugins(admittedHeartbeatConfig, {
        env: stateView.pluginMetadataEnv,
        sourceRaw: admittedHeartbeatConfig,
      })
    : undefined;
  if (snapshot.exists && !snapshot.valid && !projectedHeartbeatValidation?.ok) {
    const { collectNodeRuntimeFindings } = await import("./node-runtime-diagnostics.js");
    const runtimeFindings = await collectNodeRuntimeFindings(stateView.sourceEnv);
    const findings = [
      ...configValidationIssuesToHealthFindings(snapshot.issues),
      ...runtimeFindings,
    ];
    const visible = findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
    return {
      checksRun: 1,
      checksSkipped: 0,
      exitCode: exitCodeFromFindings(findings, sevMin),
      findings: visible,
      cleanupWarnings: stateView.cleanupWarnings,
      writeOutput() {
        if (detectDoctorLintOutputMode(opts) === "json") {
          writeJsonResult({
            ok: false,
            checksRun: 1,
            checksSkipped: 0,
            findings: visible,
            warnings: stateView.cleanupWarnings,
          });
          return;
        }
        runtime.error("doctor --lint: config file exists but does not parse cleanly.");
        for (const issue of snapshot.issues) {
          const issuePath = issue.path || "<root>";
          runtime.error(`- ${issuePath}: ${issue.message}`);
        }
        for (const finding of runtimeFindings.filter((entry) =>
          healthFindingMeetsSeverity(entry, sevMin),
        )) {
          runtime.error(
            finding.fixHint ? `${finding.message}\n${finding.fixHint}` : finding.message,
          );
        }
        for (const warning of stateView.cleanupWarnings ?? []) {
          runtime.error(`${UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX}: ${warning.message}`);
        }
      },
    };
  }

  const admittedConfig = projectedHeartbeatValidation?.ok
    ? projectedHeartbeatValidation.config
    : snapshot.config;
  const lintConfigSnapshot = projectedHeartbeatValidation?.ok
    ? {
        exists: snapshot.exists,
        issues: [],
        warnings: projectedHeartbeatValidation.warnings,
      }
    : snapshot;
  const legacyHeartbeatConfig = projectedHeartbeatValidation?.ok
    ? snapshot.sourceConfig
    : undefined;
  await loadPinnedRuntimeConfigAsync(async () => ({ config: admittedConfig }));
  const cfg = captureRuntimeConfig(admittedConfig);
  const sourceEnv = { ...stateView.sourceEnv };
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const ctx: HealthCheckContext = {
    mode: "lint",
    runtime,
    cfg,
    cwd: defaultAgentId ? resolveAgentWorkspaceDir(cfg, defaultAgentId) : process.cwd(),
    env: sourceEnv,
    allowExecSecretRefs: opts.allowExec === true,
    ...(snapshot.path !== undefined ? { configPath: snapshot.path } : {}),
  };
  const { registerBundledHealthChecks } = await import("../flows/bundled-health-checks.js");
  const availabilityFindings = registerBundledHealthChecks({
    cfg,
    cwd: ctx.cwd,
    env: stateView.pluginMetadataEnv,
    runWithPluginStateSnapshot: stateView.runWithPluginStateSnapshot,
    updateReadiness: opts.updateReadiness,
  });
  const registeredExtensionChecks = listExtensionHealthChecksForDoctor([], availabilityFindings);
  const onlyRegisteredExtensionChecks =
    opts.onlyIds !== undefined &&
    opts.onlyIds.length > 0 &&
    opts.onlyIds.every((id) => registeredExtensionChecks.some((check) => check.id === id));
  let coreChecks = onlyRegisteredExtensionChecks ? [] : stateView.coreChecks;
  if (!coreChecks) {
    const { resolveDoctorContributionHealthChecks } =
      await import("../flows/doctor-health-contributions.js");
    coreChecks = await resolveDoctorContributionHealthChecks();
  }
  const extensionChecks = onlyRegisteredExtensionChecks
    ? registeredExtensionChecks
    : listExtensionHealthChecksForDoctor(coreChecks, availabilityFindings);
  const runWithPrivateStateSnapshot: DoctorLintStateRunner = async (run) =>
    await stateView.runWithPluginStateSnapshot(async () => await run());
  // Update readiness keeps every declared check private until restart.
  const runWithSourceState: DoctorLintStateRunner = async (run) =>
    opts.updateReadiness ? run() : withDoctorLintStateEnv(sourceEnv, run, "captured");
  const coreCtx = {
    ...ctx,
    env: opts.updateReadiness ? stateView.pluginMetadataEnv : sourceEnv,
    lintConfigSnapshot,
    deep: opts.deep === true,
    runWithPrivateStateSnapshot,
    runWithSourceState,
    deferInspectionDisposal: stateView.deferInspectionDisposal,
  };

  const checks: HealthCheck[] = [
    stateSchemaHealthCheck,
    ...coreChecks.map((check): HealthCheck => {
      const checkCtx =
        legacyHeartbeatConfig && HEARTBEAT_SOURCE_CHECK_IDS.has(check.id)
          ? { ...coreCtx, cfg: legacyHeartbeatConfig }
          : coreCtx;
      return {
        ...check,
        detect(_ctx, scope) {
          const detect = async () => [
            ...(await check.detect(checkCtx, scope)),
            ...availabilityFindings.filter((finding) => finding.checkId === check.id),
          ];
          const inspectPrivate = async (run: typeof detect) => {
            let completed: HealthFinding[] | undefined;
            try {
              return await checkCtx.runWithPrivateStateSnapshot(
                async () => (completed = await run()),
              );
            } catch (error) {
              if (!completed?.length || !(error instanceof DoctorLintStateSnapshotError)) {
                throw error;
              }
              return [...completed, createStateSnapshotFailureFinding(error)];
            }
          };
          if (check.id === SKILLS_READINESS_CHECK_ID) {
            // Discovery needs source-profile eligibility; generated links use the private install roots.
            return inspectPrivate(() => checkCtx.runWithSourceState(detect));
          }
          if (
            check.id === RUNTIME_TOOL_SCHEMA_CHECK_ID ||
            check.id === PROJECT_CLONE_SHAPE_CHECK_ID
          ) {
            return inspectPrivate(detect);
          }
          // Source-bound loaders must keep the launch selectors of their retained read owner.
          return check.id === AUTH_PROFILE_CHECK_ID || HEARTBEAT_SOURCE_CHECK_IDS.has(check.id)
            ? checkCtx.runWithSourceState(detect)
            : detect();
        },
      };
    }),
    ...extensionChecks,
  ];
  const runOpts: DoctorLintRunOptions = {
    checks:
      opts.updateReadiness && opts.includeAllChecks !== true
        ? selectUpdateReadinessChecks(checks, opts.updateReadiness)
        : checks,
    includeAllChecks: opts.updateReadiness !== undefined || opts.includeAllChecks === true,
    skipIds: [...(opts.skipIds ?? []), ...(stateView.deferredCheckIds ?? [])],
    ...(opts.onlyIds && opts.onlyIds.length > 0 ? { onlyIds: opts.onlyIds } : {}),
  };
  const result = await runDoctorLintChecks(ctx, runOpts);
  const detectedFindings: readonly HealthFinding[] = [
    ...result.findings,
    ...coreChecks
      .filter((check) => stateView.deferredCheckIds?.has(check.id))
      .map((check): HealthFinding => ({
        checkId: check.id,
        source: "doctor",
        severity: "warning",
        errorCode: "update-inspection-deferred",
        requirement: "update-validation-scope",
        message:
          "Advisory inspection deferred until after update activation; required migration, config, plugin, and Gateway readiness checks remain enabled.",
        fixHint: `Run \`openclaw doctor --lint --only ${check.id}\` after activation to complete this inspection.`,
      })),
  ];
  const advisoryChecks = new Set(
    coreChecks
      .filter(
        (check) =>
          check.updateWork?.kind === "inspection" || check.updateWork?.kind === "standalone",
      )
      .map((check) => check.id),
  );
  const findings = isUpdateDoctorLintPass(stateView.sourceEnv)
    ? detectedFindings.map((finding) =>
        finding.severity === "error" && advisoryChecks.has(finding.checkId)
          ? { ...finding, severity: "warning" as const }
          : finding,
      )
    : detectedFindings;
  const databaseStores = findings.flatMap((finding) =>
    finding.checkId === "core/doctor/database-engine" && finding.details ? [finding.details] : [],
  );
  const visible = findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
  const warnings = findings.filter(
    (finding) =>
      !healthFindingMeetsSeverity(finding, sevMin) &&
      (finding.errorCode === "OPENCLAW_STATE_LEASE_ABORTED" ||
        (isUpdateDoctorLintPass(stateView.sourceEnv) && finding.severity === "warning")),
  );
  const exitCode = exitCodeFromFindings(findings, sevMin);
  const recoveryCopies = collectRecoveryDiskUsage({ cfg, env: stateView.sourceEnv });
  return {
    checksRun: result.checksRun,
    checksSkipped: result.checksSkipped,
    exitCode,
    findings: visible,
    databaseStores,
    recoveryCopies,
    warnings,
    cleanupWarnings: stateView.cleanupWarnings,
    writeOutput() {
      if (detectDoctorLintOutputMode(opts) === "json") {
        writeJsonResult({
          ok: exitCode === 0,
          checksRun: result.checksRun,
          checksSkipped: result.checksSkipped,
          findings: visible,
          databaseStores: databaseStores.length ? databaseStores : undefined,
          recoveryCopies,
          // Ordinary reports include settled cleanup warnings; rehearsal workers report before disposal.
          warnings: [...warnings, ...(stateView.cleanupWarnings ?? [])],
        });
        return;
      }
      process.stdout.write(
        `Recovery copies (read-only): ${formatRecoveryDiskUsage(recoveryCopies)}\n`,
      );
      const displayed = [...visible, ...warnings, ...(stateView.cleanupWarnings ?? [])];
      process.stdout.write(
        `doctor --lint: ran ${result.checksRun} check(s), ${displayed.length} finding(s)\n`,
      );
      if (displayed.length === 0) {
        process.stdout.write("  no findings\n");
        return;
      }
      for (const f of displayed) {
        const where = f.path !== undefined ? ` ${f.path}` : "";
        const line = f.line !== undefined ? `:${f.line}` : "";
        process.stdout.write(`  [${f.severity}] ${f.checkId}${where}${line} - ${f.message}\n`);
        if (f.fixHint !== undefined) {
          process.stdout.write(`    fix: ${f.fixHint}\n`);
        }
      }
    },
  };
}
