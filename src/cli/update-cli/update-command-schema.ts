import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryReadJson } from "../../infra/json-files.js";
import { readPackageName } from "../../infra/package-json.js";
import { checkGlobalPackageUpdateAdmission } from "../../infra/package-update-manager-preflight.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  resolveUpdateStateContentVersion,
  resolveUpdateStateTargetVersion,
} from "../../infra/update-candidate-state.versions.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import type { UpdateFailureFact } from "../../infra/update-failure-facts.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { getUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateRecoveryStep } from "../../shared/update-outcome.js";
import { UPDATE_GLOBAL_PERMISSION_REASON } from "../../shared/update-outcome.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatCliCommand } from "../command-format.js";
import { printResult } from "./progress.js";
import {
  assertReadableGitMetadata,
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
  isCandidateAdmissionContextCovered,
} from "./schema-preflight.js";
import {
  DEFAULT_PACKAGE_NAME,
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import type { RefuseUpdate } from "./update-command-result.js";
import type { prepareUpdateCommand } from "./update-command-run.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import type {
  ManagedServiceRootRedirect,
  PreManagedServiceStop,
} from "./update-command-service-context-types.js";
import type { resolveUpdateCommandTarget } from "./update-command-target.js";

type UpdateDryRunFailure = {
  recoverySteps?: readonly UpdateRecoveryStep[];
  reason: string;
  message: string;
  failureFacts?: readonly UpdateFailureFact[];
};

/** Render prepared preview facts without initializing runtime state. */
export async function previewUpdateCommand(params: {
  target: NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>;
  prepared: Pick<
    Awaited<ReturnType<typeof prepareUpdateCommand>>,
    | "shouldRestart"
    | "installKind"
    | "requestedChannel"
    | "controlPlaneUpdateSentinelMeta"
    | "packageActivationNotes"
  >;
  opts: UpdateCommandOptions;
  runId: string;
  invocationCwd?: string;
  updateStepTimeoutMs: number;
  preflight?: NonNullable<Awaited<ReturnType<typeof preflightUpdateCommandSchemas>>>;
}): Promise<void> {
  const { target, prepared, opts } = params;
  const preflight =
    params.preflight ??
    (await preflightUpdateCommandSchemas({
      ...target,
      shouldRestart: prepared.shouldRestart,
      updateStepTimeoutMs: params.updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
      packageTargetVersion: target.targetVersion ?? undefined,
      opts,
      expectedForeground:
        prepared.controlPlaneUpdateSentinelMeta?.completionOwner === "gateway-restart" || undefined,
    }));
  if (preflight) {
    preflight.preflightNotes.push(...(prepared.packageActivationNotes ?? []));
    if (target.inspectionWarning) {
      preflight.preflightNotes.push(target.inspectionWarning);
    }
    if (
      target.packageInstallTarget &&
      !target.packageAlreadyCurrent &&
      preflight.preflightFailures.length === 0
    ) {
      const admission = await checkGlobalPackageUpdateAdmission(
        target.packageInstallTarget,
        (await readPackageName(target.packageInstallTarget.packageRoot ?? target.root)) ??
          DEFAULT_PACKAGE_NAME,
      );
      if (admission?.stderrTail) {
        preflight.preflightFailures.push({
          reason:
            admission.name === "package-permissions"
              ? UPDATE_GLOBAL_PERMISSION_REASON
              : admission.name,
          message: admission.stderrTail,
          failureFacts: admission.failureFacts,
        });
        preflight.preflightNotes.push(`Would refuse update: ${admission.stderrTail}`);
      }
    }
    const mode =
      target.updateInstallKind === "git"
        ? "git"
        : (target.packageInstallTarget?.manager ?? "unknown");

    const actions: string[] = [];
    if (prepared.requestedChannel && prepared.requestedChannel !== target.storedChannel) {
      actions.push(`Persist update.channel=${prepared.requestedChannel} in config`);
    }
    if (target.switchToGit) {
      actions.push("Switch install mode from package to git checkout (dev channel)");
    } else if (target.switchToPackage) {
      actions.push(`Switch install mode from git to package manager (${mode})`);
    } else if (target.updateInstallKind === "git") {
      actions.push(`Run git update flow on channel ${target.channel} (fetch/rebase/build/doctor)`);
    } else if (target.packageAlreadyCurrent) {
      actions.push(
        `Refresh package install with spec ${target.packageInstallSpec ?? target.tag}; current version already matches ${target.targetVersion}`,
      );
    } else {
      actions.push(
        `Run global package manager update with spec ${target.packageInstallSpec ?? target.tag}`,
      );
    }
    actions.push("Run plugin update sync after core update");
    actions.push("Refresh shell completion cache (if needed)");
    actions.push(
      prepared.shouldRestart
        ? "Restart gateway service and run doctor checks"
        : "Skip restart (because --no-restart is set)",
    );

    const notes: string[] = [...(preflight.preflightNotes ?? [])];
    if (opts.tag && target.updateInstallKind === "git") {
      notes.push("--tag applies to npm installs only; git updates ignore it.");
    }
    if (target.fallbackToLatest) {
      notes.push("Beta channel resolves to latest for this run (fallback).");
    }
    if (target.managedServiceRoot) {
      actions.push(
        `Rebind the managed Gateway from ${target.managedServiceRoot} to ${target.root} after verification.`,
      );
    }
    if (target.managedServiceRootRedirect) {
      notes.push(
        `Package update targets managed service root ${target.managedServiceRootRedirect.root} instead of invoking root ${target.managedServiceRootRedirect.previousRoot}.`,
      );
    }
    if (target.explicitTag && !canResolveRegistryVersionForPackageTarget(target.tag)) {
      notes.push("Non-registry package specs skip npm version lookup and downgrade previews.");
    }
    if (hasSchemaRefusal(preflight.packageSchemaPreflight)) {
      notes.push(...formatSchemaRefusalLines(preflight.packageSchemaPreflight, true));
    }
    if (target.updateInstallKind === "git") {
      notes.push(
        "Git preview does not execute target scripts or select a build-tested development fallback. The real update repeats database admission before executing each update.",
      );
    }

    const run = getUpdateRun(params.runId, { env: opts.run?.env });
    const targetVersionReason = target.targetVersion
      ? undefined
      : target.updateInstallKind === "git"
        ? "Git dry-runs do not select a build-tested target version."
        : canResolveRegistryVersionForPackageTarget(target.packageInstallSpec ?? target.tag)
          ? "The package target version could not be resolved."
          : "The package artifact is not staged during a dry-run.";
    const preview = {
      runId: params.runId,
      run,
      dryRun: true,
      root: target.root,
      installKind: prepared.installKind,
      mode,
      updateInstallKind: target.updateInstallKind,
      switchToGit: target.switchToGit,
      switchToPackage: target.switchToPackage,
      restart: prepared.shouldRestart,
      requestedChannel: prepared.requestedChannel,
      storedChannel: target.storedChannel,
      effectiveChannel: target.channel,
      tag: target.packageInstallSpec ?? target.tag,
      currentVersion: run?.before?.version ?? target.currentVersion,
      targetVersion: target.targetVersion,
      ...(targetVersionReason ? { targetVersionReason } : {}),
      downgradeRisk: target.downgradeRisk,
      actions,
      notes,
      ...(preflight.preflightFailures?.length ? { failures: preflight.preflightFailures } : {}),
    };
    if (opts.json) {
      defaultRuntime.writeJson(preview);
    } else {
      defaultRuntime.log(theme.heading("Update dry-run"));
      defaultRuntime.log(theme.muted("No changes were applied."));
      defaultRuntime.log("");
      defaultRuntime.log(`  Root: ${theme.muted(preview.root)}`);
      defaultRuntime.log(`  Install kind: ${theme.muted(preview.installKind)}`);
      defaultRuntime.log(`  Mode: ${theme.muted(preview.mode)}`);
      defaultRuntime.log(`  Channel: ${theme.muted(preview.effectiveChannel)}`);
      defaultRuntime.log(`  Tag/spec: ${theme.muted(preview.tag)}`);
      if (preview.currentVersion) {
        defaultRuntime.log(`  Current version: ${theme.muted(preview.currentVersion)}`);
      }
      if (preview.targetVersion) {
        defaultRuntime.log(`  Target version: ${theme.muted(preview.targetVersion)}`);
      } else if (preview.targetVersionReason) {
        defaultRuntime.log(`  Target version: unresolved (${preview.targetVersionReason})`);
      }
      if (preview.downgradeRisk) {
        defaultRuntime.log(theme.warn("  Downgrade confirmation would be required in a real run."));
      }

      const printSection = (heading: string, lines: string[], format = (line: string) => line) => {
        defaultRuntime.log("");
        defaultRuntime.log(theme.heading(heading));
        for (const line of lines) {
          defaultRuntime.log(`  - ${format(line)}`);
        }
      };
      printSection("Planned actions:", preview.actions);
      if (preview.notes.length > 0) {
        printSection("Notes:", preview.notes, theme.muted);
      }
      await printResult(
        {
          runId: params.runId,
          status: "skipped",
          mode,
          reason: "dry-run",
          steps: [],
          durationMs: 0,
        },
        opts,
      );
    }
  }
}

/** Record validation, then inspect package admission or Git previews before mutation. */
export async function preflightUpdateCommandSchemas(params: {
  root: string;
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  shouldRestart: boolean;
  updateStepTimeoutMs: number;
  invocationCwd?: string;
  legacyConfigPlan?: LegacyConfigUpdatePlan;
  callerLegacyConfigPlan?: LegacyConfigUpdatePlan;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  managedServiceRoot?: string;
  channel: UpdateChannel;
  requestedChannel?: UpdateChannel | null;
  devTarget?: DevUpdateTarget;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageTargetVersion?: string;
  packageInstallSpec?: string | null;
  packageRuntimeTarget?: Parameters<typeof resolvePackageRuntimePreflight>[0]["target"];
  packageAlreadyCurrent?: boolean;
  managedServiceNodeRunner?: string;
  expectedForeground?: true;
  candidateAdmissionChecks?: readonly string[];
  opts: Pick<UpdateCommandOptions, "dryRun" | "json" | "run">;
  refuseUpdate: RefuseUpdate;
}): Promise<
  | {
      packageSchemaPreflight: OpenClawDatabaseSchemaPreflight;
      preflightNotes: string[];
      preflightFailures: UpdateDryRunFailure[];
      service?: PreManagedServiceStop;
    }
  | undefined
> {
  const {
    root,
    updateInstallKind,
    switchToGit,
    shouldRestart,
    updateStepTimeoutMs,
    invocationCwd,
    managedServiceRootRedirect,
    channel,
    devTarget,
    packageTargetSchemaVersions,
    opts,
    refuseUpdate,
  } = params;
  const run = opts.run;
  const candidateAdmissionChecks =
    updateInstallKind === "package" && !opts.dryRun
      ? (params.candidateAdmissionChecks ?? run?.candidateAdmissionChecks)
      : undefined;
  if (run) {
    recordUpdateRunPhase(run.runId, "validating", undefined, run);
  }
  let packageSchemaPreflight: OpenClawDatabaseSchemaPreflight = {
    incompatible: [],
    indeterminate: [],
  };
  const preflightNotes: string[] = [];
  const preflightFailures: UpdateDryRunFailure[] = [];
  let service: PreManagedServiceStop | undefined;
  if ((opts.dryRun || updateInstallKind === "package") && updateInstallKind !== "unknown") {
    try {
      const { inspectUpdateDatabaseContexts } =
        await import("./update-command-database-context.js");
      const { inspectGitDryRunTargetSchemaVersions } = await import("./update-command-git.js");
      const admission = await inspectUpdateDatabaseContexts({
        roots: switchToGit ? [root, resolveGitInstallDir()] : [root],
        updateInstallKind,
        shouldRestart,
        jsonMode: Boolean(opts.json),
        timeoutMs: updateStepTimeoutMs,
        invocationCwd,
        managedServiceRootRedirect,
        managedServiceRoot: params.managedServiceRoot,
        legacyConfigPlan: params.legacyConfigPlan,
        callerLegacyConfigPlan: params.callerLegacyConfigPlan,
        candidateAdmissionChecks,
        expectedForeground:
          params.expectedForeground || run?.completionOwner === "gateway-restart" || undefined,
      });
      service = admission.foreground
        ? undefined
        : (admission.service ?? admission.services.get(root));
      for (const inspectedService of admission.services.values()) {
        if (inspectedService.serviceUpdateVerdict?.kind === "unavailable") {
          preflightNotes.push(inspectedService.serviceUpdateVerdict.message);
        } else if (
          inspectedService.serviceUpdateVerdict?.kind === "owned" &&
          inspectedService.serviceUpdateVerdict.requiresInstallRootRefresh
        ) {
          preflightNotes.push(
            `Gateway service targets ${inspectedService.serviceUpdateVerdict.root}; ${shouldRestart ? "would reconcile it with" : `restart is disabled; run ${formatCliCommand("openclaw doctor --fix", inspectedService.serviceEnv)} to reconcile it with`} the active installation ${root}.`,
          );
        }
      }
      const target =
        updateInstallKind === "git"
          ? await inspectGitDryRunTargetSchemaVersions({
              root: switchToGit ? resolveGitInstallDir() : root,
              timeoutMs: updateStepTimeoutMs,
              channel,
              devTarget,
            })
          : { schemaVersions: packageTargetSchemaVersions };
      if ("metadataUnreadable" in target && target.metadataUnreadable) {
        assertReadableGitMetadata(
          target.metadataUnreadable,
          "failureCode" in target && target.failureCode ? target.failureCode : undefined,
        );
      }
      const installedContexts = candidateAdmissionChecks?.includes("database-schema")
        ? admission.contexts.filter((context) => !isCandidateAdmissionContextCovered(context.env))
        : admission.contexts;
      packageSchemaPreflight = await checkTargetDatabaseSchemasForContexts(
        target.schemaVersions,
        installedContexts,
      );
      if (opts.dryRun && updateInstallKind === "package") {
        const engineOnly =
          !params.packageAlreadyCurrent &&
          Boolean(params.packageRuntimeTarget?.nodeEngine) &&
          canResolveRegistryVersionForPackageTarget(params.packageInstallSpec ?? "");
        const runtime = await resolvePackageRuntimePreflight({
          ...params,
          engineOnly,
          target: params.packageRuntimeTarget,
          nodeRunner: params.managedServiceNodeRunner,
          timeoutMs: updateStepTimeoutMs,
          alreadyCurrent: params.packageAlreadyCurrent,
          service,
          installedRoot: params.packageAlreadyCurrent ? root : undefined,
        });
        if (!runtime.ok) {
          preflightNotes.push(`Would refuse update: ${runtime.error}`);
          preflightFailures.push({
            reason: engineOnly ? "preflight-node-runtime-incompatible" : "node-runtime-preflight",
            message: runtime.error,
            failureFacts: runtime.failureFacts,
            recoverySteps: runtime.recoverySteps,
          });
        } else if (runtime.value.replacedNodeRunner) {
          preflightNotes.push(
            `Would replace managed gateway service Node (${runtime.value.replacedNodeRunner}) with current Node (${runtime.value.nodeRunner}) for openclaw@${runtime.value.targetVersion}.`,
          );
        }
        if (
          params.packageInstallSpec &&
          !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec)
        ) {
          preflightNotes.push(
            "Configured plugin availability will be checked against the staged package before update checks or activation; this preview does not stage the target.",
          );
        } else {
          const { preflightConfiguredNpmPluginTargets } =
            await import("./update-command-plugin-preflight.js");
          const context = admission.contexts.at(-1)!;
          const pluginWarnings = await preflightConfiguredNpmPluginTargets({
            config: context.configSnapshot.sourceConfig,
            env: context.env,
            targetVersion: params.packageTargetVersion ?? null,
            channel,
            timeoutMs: updateStepTimeoutMs,
          });
          preflightNotes.push(...pluginWarnings.map((warning) => warning.message));
        }
      }
    } catch (error) {
      if (!opts.dryRun) {
        if (error instanceof UpdatePreMutationError) {
          await refuseUpdate(error.reason, error.message, error.failureFacts, error.recoverySteps);
          return undefined;
        }
        throw error;
      }
      if (!(error instanceof UpdatePreMutationError)) {
        throw error;
      }
      if (
        error.reason === "database-schema-preflight" ||
        error.reason === "target-metadata-preflight" ||
        error.reason === "invalid-config" ||
        error.reason === "config-read-failed"
      ) {
        // A best-effort preview reports incomplete admission; it never authorizes mutation.
        preflightNotes.push(error.message.replace(/^Update refused:/u, "Would refuse update:"));
      } else {
        await refuseUpdate(error.reason, error.message, error.failureFacts, error.recoverySteps);
      }
      packageSchemaPreflight = { incompatible: [], indeterminate: [] };
      if (error instanceof UpdatePreMutationError && error.reason === "target-metadata-preflight") {
        preflightFailures.push({
          reason: error.reason,
          message: error.message,
          failureFacts: error.failureFacts,
        });
      }
    }
  }
  if (!opts.dryRun && hasSchemaRefusal(packageSchemaPreflight)) {
    await refuseUpdate(
      "database-schema-preflight",
      formatSchemaRefusalLines(packageSchemaPreflight).join("\n"),
    );
    return undefined;
  }
  return { packageSchemaPreflight, preflightNotes, preflightFailures, service };
}

export async function captureUpdateActivationSchemas(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  run: UpdateCommandOptions["run"];
  candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  gatewayRestartCompletion: boolean;
  timeoutMs: number;
}) {
  const previousSchemaVersions = parsePackageOpenClawSchemaVersions(
    await tryReadJson<unknown>(path.join(params.root, "package.json")),
  );
  const schemaVersions = params.candidateSchemaVersions
    ? await readUpdateStateSchemaVersions({
        stateDir: resolveStateDir(params.env),
        config: params.config,
        env: params.env,
        timeoutMs: params.timeoutMs,
      })
    : undefined;
  const { run, candidateSchemaVersions, gatewayRestartCompletion } = params;
  if (
    run?.completionOwner === "gateway-restart" &&
    !gatewayRestartCompletion &&
    candidateSchemaVersions
  ) {
    const sharedPath = resolveOpenClawStateSqlitePath(run.env);
    if (
      schemaVersions?.some((entry) => {
        const version = resolveUpdateStateContentVersion(entry);
        return (
          version !== null &&
          version !==
            resolveUpdateStateTargetVersion(entry.path, {
              sharedPath,
              candidateSchemaVersions,
            })
        );
      })
    ) {
      throw new UpdatePreMutationError(
        "target-native-unsupported",
        "Target runtime cannot preserve the foreground Gateway's completion owner after state migration; refusing activation.",
      );
    }
  }
  return { previousSchemaVersions, schemaVersions };
}
