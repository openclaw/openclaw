import { isDeepStrictEqual } from "node:util";
import { detectCurrentSqliteCapabilities, nodeRuntimeFailure } from "../../../node-sqlite.mjs";
import { formatUnsupportedNodeVersionMessage } from "../../../node-version.mjs";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { assertConfigWriteAllowedInCurrentMode } from "../../config/config.js";
import { resolveConfigPath } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { resolveGatewayNativeServiceIdentityConflict } from "../../daemon/constants.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import {
  readControlPlaneUpdateSentinelMeta,
  UPDATE_RUN_ID_ENV,
} from "../../infra/update-control-plane-sentinel.js";
import {
  parseDevUpdateTargetEnv,
  type DevUpdateTarget,
  UPDATE_DEV_TARGET_REF_ENV,
} from "../../infra/update-dev-target.js";
import {
  createFreeBsdPkgOwnershipInspection,
  type FreeBsdPkgOwnershipInspection,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import {
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
} from "../../infra/update-post-core-context.js";
import {
  createManagedUpdateRequesterAuthority,
  resolveManagedUpdateRequester,
} from "../../infra/update-requester-authority.js";
import { normalizeControlPlaneUpdateResult } from "../../infra/update-restart-sentinel-payload.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishInterruptedUpdatePreview,
  finishUpdateRun,
  getUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunDiagnostics,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord, UpdateRunStep } from "../../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import {
  inspectUpdateRecoveries,
  loadUpdateRecovery,
  type UpdateRecoveryFence,
} from "../../infra/update-run-recovery.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import {
  AUTO_UPDATE_STEP_TIMEOUT_MS,
  DEFAULT_UPDATE_STEP_TIMEOUT_MS,
  UPDATE_RUNNER_TIMEOUT_MS,
} from "../../infra/update-run-timeouts.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { resolveExternalSupervisorGuidance } from "../../plugins/supervisor-guidance-runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { registerSignalExitBarrier, waitForSignalExitBarriers } from "../signal-exit-barrier.js";
import type { UpdateDisplayProgress } from "./progress.js";
import {
  parseUpdateTimeoutMs,
  resolveUpdateRoot,
  usesCandidateUpdateAdmission,
  type UpdateCommandOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { resolveForegroundUpdateAdmission } from "./update-command-handoff.js";
import { revalidateUpdateDatabaseContext } from "./update-command-managed-context.js";
import {
  admitMutableUpdateSignalRun,
  retireMutableUpdateSignalRun,
  withMutableUpdateSignals,
} from "./update-command-mutable-signals.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";
import {
  resolveOwnedManagedUpdateEnv,
  withOwnedManagedUpdateEnv,
  resolveServiceRefreshEnv,
} from "./update-command-service-env.js";
import {
  GatewayServiceUpdateOwnershipError,
  assertGatewayServiceManagementAllowedForUpdate,
  isGatewayServiceManagementAllowedForUpdate,
  readManagedGatewayServiceForUpdate,
  resolveManagedServicePackageUpdatePlan,
} from "./update-command-service-plan.js";

// Identity in this map is minted only for a new local preview, never reconstructed
// from a run ID, process absence, or another invocation's diagnostic history.
const previewAdmissions = new WeakMap<
  object,
  { record: UpdateRunRecord; env: NodeJS.ProcessEnv; active?: boolean }
>();

/** Advance preview custody only across this owner's committed target writes. */
export function recordUpdateCommandTarget(
  run: UpdateCommandOptions["run"],
  patch: { target?: UpdateRunRecord["target"]; step?: UpdateRunStep },
): void {
  if (!run) {
    return;
  }
  let before: UpdateRunRecord | undefined;
  const committed = recordUpdateRunPhase(
    run.runId,
    "requested",
    patch,
    { env: run.env },
    (record) => {
      before = record;
    },
  );
  const admission = previewAdmissions.get(run);
  if (admission && isDeepStrictEqual(before, admission.record)) {
    admission.record = committed;
  }
}

/** Admission follows the managed service root before a redirect or discovered install. */
export function resolveUpdateCommandAdmissionRoot(
  prepared: Pick<
    Awaited<ReturnType<typeof prepareUpdateCommand>>,
    "servicePlan" | "discoveredRoot"
  >,
): string {
  return (
    prepared.servicePlan?.serviceRoot ??
    prepared.servicePlan?.rootRedirect?.root ??
    prepared.discoveredRoot
  );
}

export async function resolveUpdateCommandAdmissionEnv(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
  pkgOwnership?: FreeBsdPkgOwnershipInspection;
  expectedForeground?: true;
}): Promise<NodeJS.ProcessEnv> {
  const pkgOwnership =
    params.pkgOwnership ?? createFreeBsdPkgOwnershipInspection(UPDATE_RUNNER_TIMEOUT_MS);
  await pkgOwnership.assertUnowned(params.root);
  let env = resolveServiceRefreshEnv(process.env, params.invocationCwd);
  if (
    await resolveForegroundUpdateAdmission({
      root: params.root,
      env,
      expectedForeground:
        params.expectedForeground ||
        params.opts.run?.completionOwner === "gateway-restart" ||
        undefined,
    })
  ) {
    return env;
  }
  // A preview belongs to its explicit state directory. Real updates follow the
  // same owned service selectors as finalization, then freeze them for all writers.
  if (
    !params.opts.dryRun &&
    !env[UPDATE_RUN_ID_ENV] &&
    isGatewayServiceManagementAllowedForUpdate(env)
  ) {
    const inspected = await readManagedGatewayServiceForUpdate(
      env,
      params.root,
      (await resolveUpdateInstallKind(params.root)) === "package",
    );
    if (inspected) {
      env = resolveOwnedManagedUpdateEnv({
        processEnv: env,
        serviceEnv: mergeGatewayServiceEnv(env, inspected.command),
        serviceDefinitionEnv: resolveManagedGatewayServiceCommand(inspected.command)?.environment,
        invocationCwd: params.invocationCwd,
      });
      // Contradictory native identity must refuse before database or target selection.
      if (resolveGatewayNativeServiceIdentityConflict(env)) {
        assertGatewayServiceManagementAllowedForUpdate(env);
      }
    }
  }
  return env;
}

/** Package admission must not open history or launch diagnostics on a retained operation. */
export function assertUpdatePackageActivationAdmission(
  root: string,
  options?: Parameters<typeof assertNoPendingPackageActivation>[1] & { serviceRoot?: string },
): void {
  try {
    assertNoPendingPackageActivation(resolveUpdateInstallRoot(root), options);
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(
      {
        status: "error",
        mode: "unknown",
        root,
        reason: "update-recovery-pending",
        steps: [],
        durationMs: 0,
      },
      formatErrorMessage(cause),
      { cause },
    );
  }
  // A retained publication still owns the service installation when the CLI updates another root.
  if (options?.serviceRoot && options.serviceRoot !== root) {
    assertUpdatePackageActivationAdmission(options.serviceRoot, {
      continuation: options.continuation,
    });
  }
}

export async function admitUpdateCommandRun(params: {
  opts: UpdateCommandOptions;
  root: string;
  installKind?: "git" | "package" | "unknown";
  serviceRoot?: string;
  invocationCwd?: string;
  pkgOwnership?: FreeBsdPkgOwnershipInspection;
  expectedForeground?: true;
  initialization?: {
    env: NodeJS.ProcessEnv;
    runId: string;
    databasePath: string;
    configPath: string;
    target: {
      configSnapshot: ConfigFileSnapshot;
      legacyConfigPlan?: LegacyConfigUpdatePlan;
      updateInstallKind?: "git" | "package" | "unknown";
    };
  };
}): Promise<NonNullable<UpdateCommandOptions["run"]>> {
  assertUpdatePackageActivationAdmission(params.root, { serviceRoot: params.serviceRoot });
  const env = await resolveUpdateCommandAdmissionEnv(params);
  // A previous invocation may have died with a sealed restoration plan. Detect
  // it before any writable owner open or history row creation changes that state.
  // An inherited diagnostic run ID is not a durable continuation claim.
  await assertUpdateRecoveryAdmission({ env });
  assertUpdatePackageActivationAdmission(params.root, { serviceRoot: params.serviceRoot });
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(env),
    env,
    recoverOrphanedSidecars: false,
  });
  if (params.initialization) {
    const initialized = params.initialization;
    if (
      resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(env)) !==
        initialized.databasePath ||
      resolvePathViaExistingAncestorSync(resolveConfigPath(env)) !== initialized.configPath
    ) {
      throw new GatewayServiceUpdateOwnershipError(
        "Gateway state or configuration selectors changed during target initialization. Retry from the installation's current owning account.",
        undefined,
      );
    }
    await revalidateUpdateDatabaseContext({
      env,
      readEnv: env,
      config: initialized.target.configSnapshot.sourceConfig,
      configSnapshot: initialized.target.configSnapshot,
      ...(initialized.target.updateInstallKind === "package" &&
      usesCandidateUpdateAdmission(params.opts, params.installKind ?? "unknown")
        ? { configValidation: "candidate" as const }
        : {}),
      ...(initialized.target.legacyConfigPlan
        ? { legacyConfigPlan: initialized.target.legacyConfigPlan }
        : {}),
    });
  }
  const meta = await readControlPlaneUpdateSentinelMeta(env);
  await resolveForegroundUpdateAdmission({
    root: params.root,
    env,
    meta,
    expectedForeground:
      params.expectedForeground ||
      params.opts.run?.completionOwner === "gateway-restart" ||
      undefined,
  });
  assertUpdatePackageActivationAdmission(params.root, { serviceRoot: params.serviceRoot });
  const driver = readUpdateRunDriver();
  const ledgerOptions = {
    env,
    busyTimeoutMs: parseUpdateTimeoutMs(params.opts.timeout) ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
  };
  const created = createUpdateRun(
    {
      runId: env[UPDATE_RUN_ID_ENV]?.trim() || params.initialization?.runId,
      trigger: "cli",
      preview: params.opts.dryRun === true,
      origin: { driver, admission: { owner: "installed" } },
      supersedeStaleIdentityless:
        !env[UPDATE_RUN_ID_ENV]?.trim() && env[POST_CORE_UPDATE_ENV] !== "1",
      target: {
        channel: params.opts.channel,
        tag: params.opts.tag,
        ...(params.installKind && params.installKind !== "unknown"
          ? { kind: params.installKind }
          : {}),
        ...(params.installKind === "git" ? { installationMethod: "git-checkout" } : {}),
      },
      before: { version: VERSION },
    },
    ledgerOptions,
  );
  const record = adoptUpdateRun(created.runId, ledgerOptions);
  const requester = resolveManagedUpdateRequester(record.origin.requester);
  const requesterAuthority = requester?.authorizationSource?.startsWith("profile:")
    ? Object.freeze({
        requester: Object.freeze({ ...requester }),
        isCurrent: () => {
          throw new Error("Profile update continuation has not acquired its native owner.");
        },
      })
    : requester
      ? await createManagedUpdateRequesterAuthority(requester, env)
      : undefined;
  const run = {
    runId: record.runId,
    defaultStepTimeoutMs: record.trigger === "campaign" ? AUTO_UPDATE_STEP_TIMEOUT_MS : undefined,
    env,
    ...(record.trigger !== "cli" &&
    meta?.runId === record.runId &&
    meta.completionOwner === "gateway-restart"
      ? { completionOwner: "gateway-restart" as const }
      : {}),
    ...(requesterAuthority ? { requesterAuthority } : {}),
  };
  if (
    !env[UPDATE_RUN_ID_ENV] &&
    env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" &&
    env[POST_CORE_UPDATE_ENV] !== "1"
  ) {
    if (params.opts.dryRun === true) {
      previewAdmissions.set(run, { record, env: { ...env } });
    } else {
      admitMutableUpdateSignalRun(run, record);
    }
  }
  return run;
}

/** Own diagnostics only for this freshly admitted invocation's lexical lifetime. */
export async function withUpdatePreviewSignals<T>(
  opts: UpdateCommandOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const admission = opts.dryRun === true && opts.run ? previewAdmissions.get(opts.run) : undefined;
  if (!admission || !opts.run || admission.active) {
    return await withMutableUpdateSignals(opts, operation);
  }
  admission.active = true;
  const { env } = admission;
  let interrupted = false;
  let shutdown: Promise<void> | undefined;
  const unregister = registerSignalExitBarrier(async () => {
    if (
      !interrupted ||
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
      process.env[POST_CORE_UPDATE_ENV] === "1"
    ) {
      return;
    }
    // Missing/displaced canonical state, pending recovery, or a changed row is
    // not permission to open a writable runtime or dispose of another owner.
    await assertUpdateRecoveryAdmission({ env });
    if (!isDeepStrictEqual(getUpdateRun(admission.record.runId, { env }), admission.record)) {
      return;
    }
    finishInterruptedUpdatePreview(admission.record, { env });
  });
  const onSignal = (code: number) => {
    interrupted = true;
    shutdown ??= waitForSignalExitBarriers()
      .catch(() => {
        defaultRuntime.error(
          "Preview interruption could not be recorded; history remains pending.",
        );
      })
      .finally(() => process.exit(code));
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await operation();
  } finally {
    await shutdown;
    previewAdmissions.delete(opts.run);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    unregister();
  }
}

export function createUpdateRunProgress(
  run: NonNullable<UpdateCommandOptions["run"]>,
  progress: UpdateDisplayProgress,
): UpdateStepProgress & {
  deferLedgerWrites: () => void;
  flushLedgerWrites: () => void;
  pendingSteps: UpdateRunStep[];
} {
  let deferred = false;
  const driver = readUpdateRunDriver();
  const pendingSteps: UpdateRunStep[] = [];
  const record = (step: UpdateRunStep) => {
    if (deferred) {
      pendingSteps.push(step);
      return undefined;
    }
    try {
      return recordUpdateRunStep(run.runId, step, { env: run.env });
    } catch (cause) {
      throw new Error(
        `Could not record update step "${step.step}" (${step.status}): ${formatErrorMessage(cause)}`,
        { cause },
      );
    }
  };
  return {
    pendingSteps,
    onRollbackOutcome: (rollbackOutcome) => {
      if (!deferred) {
        recordUpdateRunVerification(run.runId, { rollbackOutcome }, { env: run.env });
      }
    },
    onHeartbeat() {
      if (!deferred) {
        heartbeatUpdateRun(run.runId, driver, { env: run.env });
      }
    },
    deferLedgerWrites() {
      // Candidate Doctor can advance SQLite beyond this process's reader. Hold
      // activation receipts until the supported runtime owns ledger writes.
      deferred = true;
      retireMutableUpdateSignalRun(run);
    },
    flushLedgerWrites() {
      deferred = false;
      for (const step of pendingSteps.splice(0)) {
        record(step);
      }
    },
    onStepStart(step) {
      const committed = record({ step: step.name, status: "in_progress", startedAtMs: Date.now() });
      progress.onStepStart?.(step, committed);
    },
    onStepComplete(step) {
      const endedAtMs = Date.now();
      // A completed step may persist warnings; display its final committed row.
      let committed: UpdateRunRecord | undefined;
      for (const entry of updateRunStepsFromResultStep(step)) {
        committed = record({
          ...entry,
          startedAtMs: Math.max(0, endedAtMs - step.durationMs),
          endedAtMs,
        });
      }
      progress.onStepComplete?.(step, committed);
    },
  };
}

export function completeUpdateCommandRun(
  input: UpdateRunResult,
  run: UpdateCommandOptions["run"],
  completion: { rolledBack?: boolean; downtimeMs?: number } = {},
): UpdateRunResult {
  const result = normalizeControlPlaneUpdateResult(input);
  if (!run) {
    return result;
  }
  // A process-local result cannot complete an operationally pending update or
  // authorize package retirement. Only the durable finalizer may close it.
  const inspected = inspectUpdateRecoveries({ env: run.env }).find(
    (entry) => entry.record.runId === run.runId,
  );
  // A matching historical record can only project its saved outcome or remain
  // pending below. The mutable fallback still uses strict execution admission;
  // unrelated legacy evidence must not become an absent/clean recovery state.
  const recovery =
    inspected?.format === "legacy-serving"
      ? inspected.record
      : loadUpdateRecovery(run.runId, { env: run.env });
  if (
    recovery?.terminal &&
    getUpdateRun(run.runId, { env: run.env })?.status === recovery.terminal.status
  ) {
    // Read the atomic durable outcome; diagnostics never authorize retention cleanup.
    return {
      ...result,
      status: recovery.terminal.status === "succeeded" ? "ok" : "error",
      reason:
        recovery.terminal.status === "succeeded"
          ? undefined
          : (recovery.primaryFailure?.code ?? "update-rolled-back"),
      runId: run.runId,
    };
  }
  if (recovery) {
    return {
      ...result,
      status: "error",
      reason: result.reason ?? "update-recovery-pending",
      runId: run.runId,
    };
  }
  const recordOptions = { env: run.env, redactPaths: result.root ? [result.root] : [] };
  // Both finalization and outer CLI unwind come here. A verified restored generation
  // stays with its helper until native recovery finishes; neither caller may close it early.
  const helperRecoveryPending =
    process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" &&
    result.recovery?.serviceRestartSafe === true &&
    result.recovery.packageRollbackVerified === true &&
    result.recovery.service === undefined;
  const gatewayRestartPending =
    run.completionOwner === "gateway-restart" &&
    run.gatewayRestartRequired === true &&
    result.status === "ok" &&
    !completion.rolledBack;
  if (!gatewayRestartPending && !helperRecoveryPending) {
    const finished = finishUpdateRun(
      run.runId,
      {
        status: completion.rolledBack
          ? "rolled-back"
          : result.status === "ok"
            ? "succeeded"
            : result.status === "error"
              ? "failed"
              : "skipped",
        diagnostics: result,
        before: result.before,
        reason: result.reason,
        after: result.after,
        downtimeMs: completion.downtimeMs,
      },
      recordOptions,
    );
    if (result.verification) {
      result.recovery = finished.verification.recovery ?? undefined;
    }
  } else {
    recordUpdateRunPhase(
      run.runId,
      gatewayRestartPending ? "restarting" : "requested",
      { before: result.before, after: result.after },
      recordOptions,
    );
    recordUpdateRunDiagnostics(run.runId, result, defaultRuntime.error, recordOptions);
    if (!result.verification) {
      for (const step of result.steps.flatMap(updateRunStepsFromResultStep)) {
        recordUpdateRunStep(run.runId, step, recordOptions);
      }
    }
  }
  return { ...result, runId: run.runId };
}

export function readDevUpdateTarget(): DevUpdateTarget | undefined {
  const parsed = parseDevUpdateTargetEnv(process.env);
  if (parsed.status === "invalid") {
    throw new Error(
      `Invalid internal ${UPDATE_DEV_TARGET_REF_ENV} contract; expected a plain Git ref or a supported tracked-target encoding.`,
    );
  }
  return parsed.status === "valid" ? parsed.target : undefined;
}

export async function prepareUpdateCommand(opts: UpdateCommandOptions) {
  // Refuse before preflight can inspect write ownership or admit a live run ledger.
  const runtimeFailure = process.versions.bun
    ? null
    : nodeRuntimeFailure(process.versions.node, await detectCurrentSqliteCapabilities());
  if (runtimeFailure) {
    const error = `${runtimeFailure}\n${formatUnsupportedNodeVersionMessage(process.versions.node)}`;
    if (opts.json) {
      defaultRuntime.writeJson({
        status: "error",
        mode: "unknown",
        reason: "node-runtime-preflight",
        error,
        steps: [],
        durationMs: 0,
      });
    } else {
      defaultRuntime.error(`node-runtime-preflight: ${error}`);
    }
    exitCliAfterOutput(defaultRuntime, 1);
  }
  const startedAt = Date.now();
  suppressDeprecations();
  const postCoreUpdateResume = process.env[POST_CORE_UPDATE_ENV] === "1";
  const postCoreUpdateChannel = process.env[POST_CORE_UPDATE_CHANNEL_ENV]?.trim();

  const timeoutMs = parseUpdateTimeoutMs(opts.timeout);
  const shouldRestart = opts.restart !== false;
  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel !== undefined && !requestedChannel) {
    throw new Error(
      `--channel must be "stable", "extended-stable", "beta", or "dev" (got "${opts.channel}")`,
    );
  }
  let devTarget: DevUpdateTarget | undefined;
  if (requestedChannel === "dev") {
    devTarget = readDevUpdateTarget();
  }

  if (!postCoreUpdateResume && opts.dryRun !== true && isGatewayExternallySupervised()) {
    throw new Error(
      formatExternalSupervisorUpdateRequired(await resolveExternalSupervisorGuidance("update")),
    );
  }
  // The shim can move during preparation; the loaded module owns the executing generation.
  const executingRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  const discoveredRoot = opts.sourceUpdate?.root ?? (await resolveUpdateRoot());
  const installKind = await resolveUpdateInstallKind(discoveredRoot, { timeoutMs });
  if (opts.sourceUpdate && installKind !== "git") {
    throw new Error("Doctor source update requires the accepted Git checkout.");
  }
  const controlPlaneUpdateSentinelMeta = await readControlPlaneUpdateSentinelMeta();
  const foreground =
    !postCoreUpdateResume &&
    (await resolveForegroundUpdateAdmission({
      root: discoveredRoot,
      meta: controlPlaneUpdateSentinelMeta,
    }));
  const pkgOwnership = createFreeBsdPkgOwnershipInspection(timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS);
  // Inspect the invoking installation before a service can redirect its root,
  // runtime or state. This also covers package-to-Git and preview requests.
  await pkgOwnership.assertUnowned(discoveredRoot);
  // A post-core marker cannot bypass pending recovery without the live original
  // owner. Check both roots before config/autostart preparation or history.
  assertUpdatePackageActivationAdmission(discoveredRoot, {
    continuation: postCoreUpdateResume ? opts.run?.executorFence : undefined,
  });
  const servicePlan =
    installKind === "package" && !postCoreUpdateResume && !foreground
      ? await resolveManagedServicePackageUpdatePlan({
          root: discoveredRoot,
          pkgOwnership,
          rebind: shouldRestart,
        })
      : undefined;
  const packageAdmission = {
    continuation: postCoreUpdateResume ? opts.run?.executorFence : undefined,
    serviceRoot: servicePlan?.serviceRoot ?? servicePlan?.rootRedirect?.root,
  };
  assertUpdatePackageActivationAdmission(discoveredRoot, packageAdmission);
  opts.run?.executorFence?.assertCurrent();
  if (opts.dryRun !== true) {
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      recoverOrphanedSidecars: false,
    });
  }
  opts.run?.executorFence?.assertCurrent();
  const handoffRoot = controlPlaneUpdateSentinelMeta?.root;
  if (handoffRoot) {
    const { assertManagedServiceUpdateHandoffRoot } =
      await import("../../infra/update-managed-service-handoff.js");
    await assertManagedServiceUpdateHandoffRoot({
      expectedRoot: handoffRoot,
      root: discoveredRoot,
      executingRoot,
      postCore: postCoreUpdateResume,
    });
    opts.run?.executorFence?.assertCurrent();
  }
  assertUpdatePackageActivationAdmission(discoveredRoot, packageAdmission);
  if (opts.dryRun !== true) {
    try {
      assertConfigWriteAllowedInCurrentMode();
    } catch (err) {
      await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
      throw err;
    }
  }
  return {
    startedAt,
    postCoreUpdateResume,
    postCoreUpdateChannel,
    timeoutMs,
    shouldRestart,
    requestedChannel,
    devTarget,
    controlPlaneUpdateSentinelMeta,
    discoveredRoot,
    installKind,
    servicePlan,
    pkgOwnership,
  };
}

/** Prepare mutable runtime state only under the admitted installation owner. */
export async function prepareMutableUpdateRuntime(
  env: NodeJS.ProcessEnv | undefined,
  fence: UpdateRecoveryFence,
) {
  return await withOwnedManagedUpdateEnv(env, async () => {
    fence.assertCurrent();
    await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
    fence.assertCurrent();
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    fence.assertCurrent();
    await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
    fence.assertCurrent();
    const records = await loadInstalledPluginIndexInstallRecords();
    fence.assertCurrent();
    return records;
  });
}
