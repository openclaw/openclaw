import path from "node:path";
import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryReadJson } from "../../infra/json-files.js";
import { checkGlobalPackageUpdatePermissions } from "../../infra/package-update-manager-preflight.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { UPDATE_GLOBAL_PERMISSION_REASON } from "../../shared/update-outcome.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { formatCliCommand } from "../command-format.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  handleDryRunPreflightError,
  printUpdateDryRun,
  type UpdateDryRunFailure,
} from "./update-command-dry-run.js";
import type { RefuseUpdate } from "./update-command-result.js";
import type { prepareUpdateCommand } from "./update-command-run.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  resolvePackageRuntimePreflight,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import type { resolveUpdateCommandTarget } from "./update-command-target.js";

/** Render prepared preview facts without initializing runtime state. */
export async function previewUpdateCommand(params: {
  target: NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>;
  prepared: Pick<
    Awaited<ReturnType<typeof prepareUpdateCommand>>,
    "shouldRestart" | "installKind" | "requestedChannel" | "controlPlaneUpdateSentinelMeta"
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
    if (
      target.packageInstallTarget &&
      !target.packageAlreadyCurrent &&
      preflight.preflightFailures.length === 0
    ) {
      const permissions = await checkGlobalPackageUpdatePermissions(target.packageInstallTarget);
      if (permissions?.stderrTail) {
        preflight.preflightFailures.push({
          reason: UPDATE_GLOBAL_PERMISSION_REASON,
          message: permissions.stderrTail,
          failureFacts: permissions.failureFacts,
        });
        preflight.preflightNotes.push(`Would refuse update: ${permissions.stderrTail}`);
      }
    }
    await printUpdateDryRun({
      ...target,
      ...preflight,
      runId: params.runId,
      installKind: prepared.installKind,
      mode:
        target.updateInstallKind === "git"
          ? "git"
          : (target.packageInstallTarget?.manager ?? "unknown"),
      shouldRestart: prepared.shouldRestart,
      requestedChannel: prepared.requestedChannel,
      opts,
    });
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
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  managedServiceRoot?: string;
  channel: UpdateChannel;
  requestedChannel?: UpdateChannel | null;
  devTarget?: DevUpdateTarget;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageTargetVersion?: string;
  packageInstallSpec?: string | null;
  packageRuntimeTarget?: { version: string; nodeEngine: string | null };
  packageAlreadyCurrent?: boolean;
  managedServiceNodeRunner?: string;
  expectedForeground?: true;
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
  if (run) {
    recordUpdateRunPhase(run.runId, "validating", undefined, { env: run.env });
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
        const failure = createUpdatePreflightFailure(
          "target-git-metadata",
          target.metadataUnreadable,
        );
        throw new UpdatePreMutationError("target-metadata-preflight", failure.message, {
          failureFacts: failure.failureFacts,
        });
      }
      packageSchemaPreflight = await checkTargetDatabaseSchemasForContexts(
        target.schemaVersions,
        admission.contexts,
      );
      if (opts.dryRun && updateInstallKind === "package") {
        const runtime = await resolvePackageRuntimePreflight({
          ...params,
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
            reason: "node-runtime-preflight",
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
      packageSchemaPreflight = await handleDryRunPreflightError(
        error,
        preflightNotes,
        refuseUpdate,
      );
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

function assertForegroundUpdateSchemaSupport(
  run: UpdateCommandOptions["run"],
  candidate: OpenClawSchemaVersions | undefined,
  schemas: UpdateStateSchemaVersion[] | undefined,
  gatewayRestartCompletion: boolean,
): void {
  if (run?.completionOwner !== "gateway-restart" || gatewayRestartCompletion || !candidate) {
    return;
  }
  const sharedPath = resolveOpenClawStateSqlitePath(run.env);
  if (
    schemas?.some((entry) => {
      const version = resolveUpdateStateContentVersion(entry);
      return (
        version !== null && version !== candidate[entry.path === sharedPath ? "state" : "agent"]
      );
    })
  ) {
    throw new UpdatePreMutationError(
      "target-native-unsupported",
      "Target runtime cannot preserve the foreground Gateway's completion owner after state migration; refusing activation.",
    );
  }
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
  assertForegroundUpdateSchemaSupport(
    params.run,
    params.candidateSchemaVersions,
    schemaVersions,
    params.gatewayRestartCompletion,
  );
  return { previousSchemaVersions, schemaVersions };
}
