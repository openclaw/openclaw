import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
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
import { handleDryRunPreflightError, printUpdateDryRun } from "./update-command-dry-run.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-plan.js";
import type { resolveUpdateCommandTarget } from "./update-command-target.js";

/** Render prepared preview facts without initializing runtime state. */
export async function previewUpdateCommand(params: {
  target: NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>;
  prepared: {
    shouldRestart: boolean;
    installKind: "git" | "package" | "unknown";
    requestedChannel: UpdateChannel | null;
  };
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
    }));
  if (preflight) {
    printUpdateDryRun({
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
  channel: UpdateChannel;
  devTarget?: DevUpdateTarget;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageTargetVersion?: string;
  packageInstallSpec?: string | null;
  opts: Pick<UpdateCommandOptions, "dryRun" | "json" | "run">;
  refuseUpdate: (reason: string, message?: string) => Promise<void>;
}): Promise<
  { packageSchemaPreflight: OpenClawDatabaseSchemaPreflight; preflightNotes: string[] } | undefined
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
        legacyConfigPlan: params.legacyConfigPlan,
      });
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
        throw new UpdatePreMutationError(
          "target-metadata-preflight",
          `Could not preview Git target schema support without changing the checkout: ${target.metadataUnreadable}`,
        );
      }
      packageSchemaPreflight = await checkTargetDatabaseSchemasForContexts(
        target.schemaVersions,
        admission.contexts,
      );
      if (opts.dryRun && updateInstallKind === "package") {
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
          await refuseUpdate(error.reason, error.message);
          return undefined;
        }
        throw error;
      }
      packageSchemaPreflight = await handleDryRunPreflightError(
        error,
        preflightNotes,
        refuseUpdate,
      );
    }
  }
  if (!opts.dryRun && hasSchemaRefusal(packageSchemaPreflight)) {
    await refuseUpdate(
      "database-schema-preflight",
      formatSchemaRefusalLines(packageSchemaPreflight).join("\n"),
    );
    return undefined;
  }
  return { packageSchemaPreflight, preflightNotes };
}
