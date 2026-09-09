import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { readPackageVersion, resolveNodeRunner, UpdatePreMutationError } from "./shared.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import {
  formatUpdateAncestryBlockMessage,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdateContext,
  revalidateUpdateDatabaseContext,
  withOwnedManagedUpdateEnv,
} from "./update-command-managed-context.js";
import { preflightConfiguredNpmPluginTargets } from "./update-command-plugin-preflight.js";
import type { FinishUpdateParams } from "./update-command-post-update-types.js";
import { finishUpdate } from "./update-command-post-update.js";
import {
  GatewayServiceUpdateOwnershipError,
  resolvePackageRuntimePreflight,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
} from "./update-command-service.js";

/** A current core still owns plugin convergence, but only changed plugins need activation. */
export async function finishAlreadyCurrentUpdate(
  params: Pick<
    FinishUpdateParams,
    | "opts"
    | "result"
    | "root"
    | "requestedChannel"
    | "storedChannel"
    | "channel"
    | "shouldRestart"
    | "updateStepTimeoutMs"
    | "invocationCwd"
    | "startedAt"
    | "controlPlaneUpdateSentinelMeta"
    | "packageUpdateNodeRunner"
    | "ownedManagedUpdateEnv"
  > & {
    managedServiceRootRedirect: ManagedServiceRootRedirect | null;
    runtimeTarget?: { version: string; nodeEngine: string | null };
    stop: () => void;
    refuseUpdate: (reason: string, message?: string) => Promise<void>;
  },
): Promise<void> {
  await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () => {
    const result = {
      ...params.result,
      after: {
        ...(params.result.after ?? params.result.before),
        version:
          params.result.after?.version ??
          params.result.before?.version ??
          (await readPackageVersion(params.root)),
      },
    };
    const inspection = {
      roots: [params.root],
      updateInstallKind: params.result.mode === "git" ? ("git" as const) : ("package" as const),
      shouldRestart: params.shouldRestart,
      jsonMode: Boolean(params.opts.json),
      timeoutMs: params.updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
      managedServiceRootRedirect: params.managedServiceRootRedirect,
    };
    const admission = await inspectUpdateDatabaseContexts(inspection);
    const service = admission.service;
    const runtime = await resolvePackageRuntimePreflight({
      target: params.runtimeTarget,
      installedRoot: params.root,
      nodeRunner: service?.serviceNodeRunner ?? params.packageUpdateNodeRunner,
      fallbackNodeRunner:
        params.shouldRestart &&
        service?.running &&
        service.serviceUpdateVerdict?.kind === "owned" &&
        service.serviceUpdateVerdict.refreshDefinition
          ? resolveNodeRunner()
          : undefined,
      timeoutMs: params.updateStepTimeoutMs,
    });
    if (!runtime.ok) {
      throw new UpdatePreMutationError("node-runtime-preflight", runtime.error);
    }
    const packageUpdateNodeRunner = runtime.value.nodeRunner;
    const context = admission.contexts.at(-1)!;
    await preflightConfiguredNpmPluginTargets({
      config: context.configSnapshot.sourceConfig,
      env: context.env,
      targetVersion: result.after.version,
      channel: params.channel,
      timeoutMs: params.updateStepTimeoutMs,
    });
    await inspectUpdateDatabaseContexts({ ...inspection, expectedServices: admission.services });
    await Promise.all(admission.contexts.map(revalidateUpdateDatabaseContext));
    let stopState;
    try {
      stopState = await maybeStopManagedServiceBeforeMutableUpdate({
        ...inspection,
        root: params.root,
        phase: "inspect",
        expectedService: admission.services.get(params.root),
        updateRun: params.opts.run,
        handoffFromGateway: (state) =>
          handoffUpdateFromGateway({
            state,
            root: params.root,
            mode: params.result.mode,
            opts: params.opts,
            tag:
              params.channel === "extended-stable"
                ? undefined
                : (result.after.version ?? undefined),
            timeoutMs: params.updateStepTimeoutMs,
            nodeRunner: packageUpdateNodeRunner,
            invocationCwd: params.invocationCwd,
            stopProgress: params.stop,
          }),
      });
    } catch (error) {
      if (error instanceof UpdateCommandAbort) {
        return;
      }
      throw error;
    }
    if (
      stopState.blockMessage ||
      shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop: stopState })
    ) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(
          stopState.blockMessage ??
            "Run openclaw update from a terminal outside the Gateway service before changing installed plugins.",
        ),
      );
    }
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(context.env),
      env: context.env,
    });
    const owned = await captureOwnedManagedUpdateContext({
      stopState,
      invocationCwd: params.invocationCwd,
    });
    const env = owned?.env ?? context.env;
    params.stop();
    await finishUpdate({
      ...params,
      packageUpdateNodeRunner,
      serviceRuntimeRefreshRequired: runtime.value.replacedNodeRunner !== undefined,
      result: { ...result, status: "skipped", reason: "already-current" },
      coreAlreadyCurrent: true,
      mutationStarted: false,
      installKindChanged: false,
      downgradeRisk: false,
      preManagedServiceStop: stopState,
      ownedManagedUpdateEnv: env,
      configSnapshot: owned?.configSnapshot ?? context.configSnapshot,
      preUpdatePluginInstallRecords: owned?.pluginInstallRecords ?? {},
    });
  }).catch(async (error: unknown) => {
    if (
      error instanceof UpdatePreMutationError ||
      error instanceof GatewayServiceUpdateOwnershipError
    ) {
      await params.refuseUpdate(
        error instanceof UpdatePreMutationError ? error.reason : "managed-service-preflight",
        error.message,
      );
      return;
    }
    throw error;
  });
}
