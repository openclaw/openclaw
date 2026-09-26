/** CLI entrypoint for non-mutating doctor lint health checks. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite.js";
import {
  createConfigIO,
  readConfigFileSnapshot,
  readConfigFileSnapshotWithPluginMetadata,
} from "../config/config.js";
import { maybeLoadDotEnvForConfig } from "../config/io.runtime-env.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import { configValidationIssuesToHealthFindings } from "../flows/doctor-config-validation-findings.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { DoctorHealthCheckContext } from "../flows/doctor-health-contribution-types.js";
import {
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
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX } from "../infra/update-doctor-lint.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../plugins/install-root-context.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withDisposableOpenClawStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import {
  createStateSnapshotFailureExecution,
  createStateSnapshotFailureFinding,
  detectDoctorLintOutputMode,
  writeJsonResult,
  type DoctorLintExecution,
} from "./doctor-lint-output.js";
import { isPostCoreConvergencePass, isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

type DoctorLintStateView = {
  coreChecks?: readonly DoctorHealthCheck[];
  deferredCheckIds?: ReadonlySet<string>;
  deferInspectionDisposal?: DoctorHealthCheckContext["deferInspectionDisposal"];
  cleanupWarnings?: HealthFinding[];
  pluginMetadataEnv: NodeJS.ProcessEnv;
  readConfigSnapshot: () => ReturnType<typeof readConfigFileSnapshot>;
  sourceEnv: NodeJS.ProcessEnv;
  runWithPluginStateSnapshot: <T>(
    run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
  ) => Promise<T>;
};

type DoctorLintStateRunner = <T>(run: () => Promise<T>) => Promise<T>;

const RUNTIME_TOOL_SCHEMA_CHECK_ID = "core/doctor/runtime-tool-schemas";
const PROJECT_CLONE_SHAPE_CHECK_ID = "core/doctor/project-clone-shape";
const SKILLS_READINESS_CHECK_ID = "core/doctor/skills-readiness";
const AUTH_PROFILE_CHECK_ID = "core/doctor/auth-profiles";

class DoctorLintStateSnapshotError extends Error {
  constructor(cause: unknown) {
    super(
      `Doctor lint could not prepare a private plugin-state snapshot: ${scrubDoctorErrorMessage(cause)}`,
      { cause },
    );
    this.name = "DoctorLintStateSnapshotError";
  }
}

/**
 * Runs registered doctor health checks in human or JSON mode and returns the lint exit code.
 *
 * Invalid config is reported before regular health checks because most checks need a parsed config
 * and workspace root.
 */
export async function runDoctorLintCli(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
): Promise<number> {
  if (runtime === defaultRuntime && opts.json && resolveUpdateRehearsalRoot(process.env)) {
    const { hasCliProcessScope } = await import("../cli/runtime-cleanup-scope.js");
    if (hasCliProcessScope()) {
      const { runUpdateDoctorLintProcess } = await import("./doctor-lint-process.js");
      const budget = await resolveDoctorUpdateBudget({ cfg: {}, env: process.env });
      return runUpdateDoctorLintProcess(opts, budget?.disposalDeadlineMs);
    }
  }
  return runDoctorLintCliInProcess(runtime, opts);
}

/** The rehearsal worker keeps its private state alive after publishing the check result. */
export async function runDoctorLintCliInProcess(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  reportBeforeDisposal = false,
): Promise<number> {
  let reported: DoctorLintExecution | undefined;
  const report = (execution: DoctorLintExecution) => {
    execution.writeOutput();
    reported = execution;
  };
  try {
    const execution = await withArtifactPreservingStateReads(() =>
      prepareDoctorLintExecution(runtime, opts, reportBeforeDisposal ? report : undefined),
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
  const execution = await withArtifactPreservingStateReads(() =>
    prepareDoctorLintExecution(runtime, { severityMin: "info" }),
  );
  return execution.findings;
}

async function prepareDoctorLintExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  onChecksComplete?: (execution: DoctorLintExecution) => void,
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
      const budget = await resolveDoctorUpdateBudget({ cfg: snapshot.config, env: sourceEnv });
      if (
        budget &&
        !admitDoctorUpdateInspection(budget, "agent", [
          { id: "core/doctor/lint-inspection", label: "Doctor lint inspection" },
        ])
      ) {
        const warnings = [...budget.deferred.values()];
        return {
          checksRun: 0,
          checksSkipped: 0,
          exitCode: 0,
          findings: warnings,
          writeOutput() {
            if (detectDoctorLintOutputMode(opts) === "json") {
              writeJsonResult({ ok: true, checksRun: 0, checksSkipped: 0, findings: [], warnings });
            } else {
              for (const finding of warnings) {
                runtime.log(
                  `[warning] ${finding.checkId} [${finding.errorCode}]: ${finding.message}`,
                );
                runtime.log(finding.fixHint ?? "Run `openclaw doctor` after activation.");
              }
            }
          },
        };
      }
    }
  }
  const cleanupWarnings: HealthFinding[] | undefined = isUpdateDoctorLintPass(sourceEnv)
    ? []
    : undefined;
  const run = () =>
    prepareDoctorLintStateExecution(
      runtime,
      opts,
      sevMin,
      sourceEnv,
      cleanupWarnings,
      onChecksComplete,
    );
  // Full reports share private source bytes. Selected checks retain on-demand inspection.
  if (opts.onlyIds?.length) {
    return await run();
  }
  let execution: DoctorLintExecution | undefined;
  try {
    return await withOpenClawStateDatabaseReadSnapshot(async () => (execution = await run()), {
      env: sourceEnv,
    });
  } catch (error) {
    if (!execution || !cleanupWarnings || !(error instanceof SqliteSnapshotCleanupError)) {
      throw error;
    }
    recordSnapshotCleanupWarning(cleanupWarnings);
    return execution;
  }
}

async function prepareDoctorLintStateExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  sevMin: NonNullable<ReturnType<typeof parseHealthFindingSeverity>>,
  sourceEnv: NodeJS.ProcessEnv,
  cleanupWarnings: HealthFinding[] | undefined,
  onChecksComplete?: (execution: DoctorLintExecution) => void,
): Promise<DoctorLintExecution> {
  const updateReadiness = isPostCoreConvergencePass(sourceEnv) ? "post-plugin" : undefined;
  const effectiveOpts: DoctorLintCliOptions = updateReadiness ? { ...opts, updateReadiness } : opts;
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
  const stateView: DoctorLintStateView = {
    coreChecks,
    deferredCheckIds,
    cleanupWarnings,
    pluginMetadataEnv: sourceEnv,
    sourceEnv,
    readConfigSnapshot,
    runWithPluginStateSnapshot: async (run) =>
      withReadOnlyPluginStateSnapshot(sourceEnv, run, cleanupWarnings),
  };
  if (pluginStateMode !== "isolated" && !onChecksComplete) {
    return await executeDoctorLint(runtime, effectiveOpts, sevMin, stateView);
  }
  let checksReported = false;
  let completedExecution: DoctorLintExecution | undefined;
  try {
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
}

async function executeDoctorLint(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  sevMin: NonNullable<ReturnType<typeof parseHealthFindingSeverity>>,
  stateView: DoctorLintStateView,
): Promise<DoctorLintExecution> {
  const snapshot = await stateView.readConfigSnapshot();
  if (snapshot.exists && !snapshot.valid) {
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

  const cfg = captureRuntimeConfig(snapshot.config);
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
    opts.updateReadiness ? run() : withDoctorLintStateEnv(sourceEnv, run);
  const coreCtx = {
    ...ctx,
    env: opts.updateReadiness ? stateView.pluginMetadataEnv : sourceEnv,
    lintConfigSnapshot: snapshot,
    deep: opts.deep === true,
    runWithPrivateStateSnapshot,
    runWithSourceState,
    deferInspectionDisposal: stateView.deferInspectionDisposal,
  };

  const checks = [
    ...coreChecks.map((check) => withCoreLintContext(check, coreCtx, availabilityFindings)),
    ...extensionChecks,
  ];
  const runOpts: DoctorLintRunOptions = {
    checks: opts.updateReadiness
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
  const visible = findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
  const warnings = findings.filter(
    (finding) =>
      !healthFindingMeetsSeverity(finding, sevMin) &&
      (finding.errorCode === "OPENCLAW_STATE_LEASE_ABORTED" ||
        (isUpdateDoctorLintPass(stateView.sourceEnv) && finding.severity === "warning")),
  );
  const exitCode = exitCodeFromFindings(findings, sevMin);
  return {
    checksRun: result.checksRun,
    checksSkipped: result.checksSkipped,
    exitCode,
    findings: visible,
    warnings,
    cleanupWarnings: stateView.cleanupWarnings,
    writeOutput() {
      const mode = detectDoctorLintOutputMode(opts);
      if (mode === "json") {
        writeJsonResult({
          ok: exitCode === 0,
          checksRun: result.checksRun,
          checksSkipped: result.checksSkipped,
          findings: visible,
          // Ordinary reports include settled cleanup warnings; rehearsal workers report before disposal.
          warnings: [...warnings, ...(stateView.cleanupWarnings ?? [])],
        });
        return;
      }
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

async function withReadOnlyPluginStateSnapshot<T>(
  sourceEnv: NodeJS.ProcessEnv,
  run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
  cleanupWarnings?: HealthFinding[],
): Promise<T> {
  const sourceDatabasePath = resolveOpenClawStateSqlitePath(sourceEnv);
  let cleanup: () => Promise<boolean>;
  let privateRoot: string;
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  try {
    if (fs.existsSync(sourceDatabasePath)) {
      prepared = prepareSqliteReadOnlyLocationSync(sourceDatabasePath);
      privateRoot = path.dirname(prepared.location);
      cleanup = prepared.cleanupAsync;
    } else {
      privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-state-"));
      cleanup = async () => {
        try {
          await fs.promises.rm(privateRoot, { force: true, recursive: true });
          return true;
        } catch {
          return false;
        }
      };
    }
  } catch (error) {
    throw new DoctorLintStateSnapshotError(error);
  }
  const privateStateDir = path.join(privateRoot, "openclaw-state");
  const privateDatabasePath = resolveOpenClawStateSqlitePath({
    ...sourceEnv,
    OPENCLAW_STATE_DIR: privateStateDir,
  });
  const privateEnv = {
    ...sourceEnv,
    OPENCLAW_CONFIG_PATH: resolveConfigPath(sourceEnv, resolveStateDir(sourceEnv)),
    OPENCLAW_STATE_DIR: privateStateDir,
  };
  return await withDoctorLintStateEnv(privateEnv, async () => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    let runStarted = false;
    try {
      fs.mkdirSync(path.dirname(privateDatabasePath), { recursive: true, mode: 0o700 });
      if (prepared) {
        for (const suffix of ["", "-journal", "-shm", "-wal"]) {
          const sourcePath = `${prepared.location}${suffix}`;
          if (fs.existsSync(sourcePath)) {
            fs.renameSync(sourcePath, `${privateDatabasePath}${suffix}`);
          }
        }
      }
      const installRoots = resolvePluginInstallRoots(sourceEnv);
      // Global readers and local inspector writes share the private state view.
      // Runtime schema checks defer OAuth probes: external rotation cannot be snapshotted.
      outcome = {
        ok: true,
        value: await withDisposableOpenClawStateReads(privateDatabasePath, () =>
          withPluginInstallRoots({ ...installRoots, stateDir: privateStateDir }, async () => {
            runStarted = true;
            return await run(privateEnv);
          }),
        ),
      };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      // Independent owners must both retire, even if one close fails. Retain
      // the snapshot on any failure, without losing an earlier detector error.
      const retirementErrors: unknown[] = [];
      try {
        closeAuthProfileReadPool({ kind: "root", rootPath: privateStateDir });
      } catch (error) {
        retirementErrors.push(error);
      }
      try {
        await closeOpenClawStateDatabaseByPathAsync(privateDatabasePath);
      } catch (error) {
        retirementErrors.push(error);
      }
      if (retirementErrors.length > 0) {
        throw new AggregateError(
          retirementErrors,
          retirementErrors.map((error) => scrubDoctorErrorMessage(error)).join("; "),
        );
      }
      if (!(await cleanup())) {
        const message = "Temporary doctor lint state snapshot cleanup did not complete.";
        if (!cleanupWarnings) {
          throw new Error(message);
        }
        // Only disposal of private bytes is advisory. Preserve the detector's outcome;
        // filtering its later error would lose real findings hidden by cleanup failure.
        recordSnapshotCleanupWarning(cleanupWarnings);
      }
    } catch (error) {
      // Neither owner retirement nor ordinary byte cleanup may hide a detector failure.
      throw new DoctorLintStateSnapshotError(
        outcome.ok
          ? error
          : new AggregateError(
              [outcome.error, error],
              `${scrubDoctorErrorMessage(outcome.error)}; ${scrubDoctorErrorMessage(error)}`,
            ),
      );
    }
    if (!outcome.ok) {
      throw runStarted ? outcome.error : new DoctorLintStateSnapshotError(outcome.error);
    }
    return outcome.value;
  });
}

function recordSnapshotCleanupWarning(warnings: HealthFinding[]): void {
  warnings.push({
    checkId: "core/doctor/lint-state-inspection",
    severity: "warning",
    requirement: "temporary-snapshot-cleanup",
    message: "Temporary doctor lint state snapshot cleanup did not complete.",
    fixHint: "Rerun `openclaw doctor --lint` after the update to check snapshot cleanup.",
  });
}

async function withDoctorLintStateEnv<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const stateDir = resolveStateDir(env);
  const overrides = {
    OPENCLAW_CONFIG_PATH: resolveConfigPath(env, stateDir),
    OPENCLAW_STATE_DIR: stateDir,
  };
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  // Doctor checks run serially. Scope ambient auth/global-store owners together,
  // restoring the enclosing private view even when a detector throws.
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withCoreLintContext(
  check: HealthCheck,
  ctx: DoctorHealthCheckContext & {
    readonly deep?: boolean;
    readonly runWithPrivateStateSnapshot: DoctorLintStateRunner;
    readonly runWithSourceState: DoctorLintStateRunner;
  },
  availabilityFindings: readonly HealthFinding[],
): HealthCheck {
  return {
    ...check,
    detect(_ctx, scope) {
      const detect = async () => [
        ...(await check.detect(ctx, scope)),
        ...availabilityFindings.filter((finding) => finding.checkId === check.id),
      ];
      const inspectPrivate = async (run: typeof detect) => {
        let completed: HealthFinding[] | undefined;
        try {
          return await ctx.runWithPrivateStateSnapshot(async () => (completed = await run()));
        } catch (error) {
          if (!completed?.length || !(error instanceof DoctorLintStateSnapshotError)) {
            throw error;
          }
          return [...completed, createStateSnapshotFailureFinding(error)];
        }
      };
      if (check.id === SKILLS_READINESS_CHECK_ID) {
        // Discovery needs source-profile eligibility; generated links use the private install roots.
        return inspectPrivate(() => ctx.runWithSourceState(detect));
      }
      if (check.id === RUNTIME_TOOL_SCHEMA_CHECK_ID || check.id === PROJECT_CLONE_SHAPE_CHECK_ID) {
        return inspectPrivate(detect);
      }
      // Auth health uses read-only loaders but needs uncopied agent stores and source paths.
      return check.id === AUTH_PROFILE_CHECK_ID ? ctx.runWithSourceState(detect) : detect();
    },
  };
}
