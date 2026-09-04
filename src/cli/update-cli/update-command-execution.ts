import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import {
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
  type TargetDatabaseSchemaContext,
} from "./schema-preflight.js";
import {
  normalizeTag,
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  createBeforeGitMutation,
  inspectGitDryRunTargetSchemaVersions,
  updateGitInstall,
} from "./update-command-git.js";
import {
  formatUpdateAncestryBlockMessage,
  formatUpdateGatewayServiceProcessBlockMessage,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import {
  assertReadableCallerUpdateConfig,
  captureOwnedManagedUpdateContext,
  captureOwnedManagedUpdatePreflightContext,
  recaptureCallerUpdateConfig,
  recaptureOwnedManagedUpdateConfig,
  type OwnedManagedUpdateContext,
  type OwnedManagedUpdatePreflightContext,
} from "./update-command-managed-context.js";
import { runPackageInstallUpdate } from "./update-command-package.js";
import {
  GatewayServiceUpdateOwnershipError,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolvePreparedGatewayUpdatePolicy,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";

type MutableUpdateExecutionResult = {
  result: UpdateRunResult;
  failure?: { cause: unknown; detail: string };
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  recoveryEnv: NodeJS.ProcessEnv | undefined;
};

function resolveTargetDatabaseSchemaContexts(params: {
  caller: { configSnapshot: ConfigFileSnapshot; env: NodeJS.ProcessEnv };
  managed?: TargetDatabaseSchemaContext;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
}): TargetDatabaseSchemaContext[] {
  // A redirected service root belongs to another installation. Its package
  // replacement must not adopt state selected by the caller's shell install.
  if (params.managedServiceRootRedirect) {
    if (!params.managed) {
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        "The managed Gateway service changed before update admission. Re-run the update so its package root and state can be inspected together.",
      );
    }
    return [params.managed];
  }
  assertReadableCallerUpdateConfig(params.caller.configSnapshot);
  const caller = {
    config: params.caller.configSnapshot.sourceConfig,
    env: params.caller.env,
  };
  return params.managed ? [caller, params.managed] : [caller];
}

function assertReadOnlyManagedServiceInspection(params: {
  preManagedServiceStop: PreManagedServiceStop | undefined;
  updateInstallKind: "git" | "package";
}): void {
  const { preManagedServiceStop } = params;
  const gatewayProcessBlock =
    shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) &&
    (!preManagedServiceStop?.inspected ||
      preManagedServiceStop.serviceUpdateVerdict?.kind === "unavailable");
  if (preManagedServiceStop?.blockMessage) {
    const message =
      gatewayProcessBlock && preManagedServiceStop.serviceUpdateVerdict?.kind === "unavailable"
        ? formatUpdateGatewayServiceProcessBlockMessage(
            params.updateInstallKind === "git" ? "Git updates" : "Package updates",
          )
        : formatUpdateAncestryBlockMessage(preManagedServiceStop.blockMessage);
    throw new UpdatePreMutationError("managed-service-preflight", message);
  }
  if (gatewayProcessBlock) {
    const updateLabel = params.updateInstallKind === "git" ? "Git updates" : "Package updates";
    throw new UpdatePreMutationError(
      "managed-service-preflight",
      formatUpdateGatewayServiceProcessBlockMessage(updateLabel),
    );
  }
}

async function inspectOwnedManagedUpdatePreflight(params: {
  root: string;
  updateInstallKind: "git" | "package";
  shouldRestart: boolean;
  jsonMode: boolean;
  timeoutMs: number;
  invocationCwd?: string;
}): Promise<{
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdatePreflightContext: OwnedManagedUpdatePreflightContext | undefined;
}> {
  let preManagedServiceStop: PreManagedServiceStop | undefined =
    await maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: params.updateInstallKind,
      root: params.root,
      shouldRestart: params.shouldRestart,
      jsonMode: params.jsonMode,
      timeoutMs: params.timeoutMs,
      phase: "inspect",
    });
  if (preManagedServiceStop.serviceUpdateVerdict?.kind === "foreign") {
    preManagedServiceStop = undefined;
  }
  let ownedManagedUpdatePreflightContext: OwnedManagedUpdatePreflightContext | undefined;
  try {
    ownedManagedUpdatePreflightContext = await captureOwnedManagedUpdatePreflightContext({
      stopState: preManagedServiceStop,
      processEnv: process.env,
      invocationCwd: params.invocationCwd,
    });
  } catch (err) {
    if (err instanceof UpdatePreMutationError) {
      throw err;
    }
    throw new Error(`Failed to capture managed gateway update state: ${String(err)}`, {
      cause: err,
    });
  }
  assertReadOnlyManagedServiceInspection({
    preManagedServiceStop,
    updateInstallKind: params.updateInstallKind,
  });
  return { preManagedServiceStop, ownedManagedUpdatePreflightContext };
}

/** Dry-run reads the same caller/service stores as mutation without acquiring write authority. */
export async function inspectDryRunTargetDatabaseSchemas(params: {
  root: string;
  updateInstallKind: "git" | "package" | "unknown";
  shouldRestart: boolean;
  jsonMode: boolean;
  timeoutMs: number;
  invocationCwd?: string;
  supportedVersions?: OpenClawSchemaVersions;
  channel: "stable" | "extended-stable" | "beta" | "dev";
  devTarget?: DevUpdateTarget;
  gitTargetRoot?: string;
  callerDatabaseSchemaContext: { configSnapshot: ConfigFileSnapshot; env: NodeJS.ProcessEnv };
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
}): Promise<ReturnType<typeof checkTargetDatabaseSchemasForContexts>> {
  if (params.updateInstallKind === "unknown") {
    return { incompatible: [], indeterminate: [] };
  }
  const inspected = await inspectOwnedManagedUpdatePreflight({
    root: params.root,
    updateInstallKind: params.updateInstallKind,
    shouldRestart: params.shouldRestart,
    jsonMode: params.jsonMode,
    timeoutMs: params.timeoutMs,
    invocationCwd: params.invocationCwd,
  });
  const managed = inspected.ownedManagedUpdatePreflightContext;
  let supportedVersions = params.supportedVersions;
  if (params.updateInstallKind === "git") {
    const target = await inspectGitDryRunTargetSchemaVersions({
      root: params.gitTargetRoot ?? params.root,
      timeoutMs: params.timeoutMs,
      channel: params.channel,
      devTarget: params.devTarget,
    });
    if (target.metadataUnreadable) {
      throw new UpdatePreMutationError(
        "target-metadata-preflight",
        `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}). Retry, or see ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
      );
    }
    supportedVersions = target.schemaVersions;
  }
  return checkTargetDatabaseSchemasForContexts(
    supportedVersions,
    resolveTargetDatabaseSchemaContexts({
      caller: params.callerDatabaseSchemaContext,
      managed: managed
        ? {
            config: managed.configSnapshot.sourceConfig ?? managed.configSnapshot.config,
            env: managed.env,
          }
        : undefined,
      managedServiceRootRedirect: params.managedServiceRootRedirect,
    }),
  );
}

export async function executeMutableUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  timeoutMs: number | undefined;
  updateStepTimeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  stop: () => void;
  channel: "stable" | "extended-stable" | "beta" | "dev";
  tag: string;
  opts: UpdateCommandOptions;
  shouldRestart: boolean;
  devTarget?: DevUpdateTarget;
  packageInstallSpec: string | null;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageInstallTarget?: ResolvedGlobalInstallTarget;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageUpdateNodeRunner?: string;
  managedServiceNodeRunner?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  invocationCwd?: string;
  recoveryState: UpdateCommandRecoveryState;
  callerDatabaseSchemaContext: { configSnapshot: ConfigFileSnapshot; env: NodeJS.ProcessEnv };
  prepareMutableUpdate: (env?: NodeJS.ProcessEnv) => Promise<void>;
}): Promise<MutableUpdateExecutionResult | null> {
  let preManagedServiceStop: PreManagedServiceStop | undefined;
  let inspectedOwnedManagedUpdatePreflightStop: PreManagedServiceStop | undefined;
  let ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  let ownedManagedUpdatePreflightContext: OwnedManagedUpdatePreflightContext | undefined;
  let callerDatabaseSchemaContext = params.callerDatabaseSchemaContext;
  const getTargetDatabaseSchemaContexts = () => {
    const managedConfigSnapshot =
      ownedManagedUpdateContext?.configSnapshot ??
      ownedManagedUpdatePreflightContext?.configSnapshot;
    const managedEnv = ownedManagedUpdateContext?.env ?? ownedManagedUpdatePreflightContext?.env;
    return resolveTargetDatabaseSchemaContexts({
      caller: callerDatabaseSchemaContext,
      managed:
        managedConfigSnapshot && managedEnv
          ? {
              config: managedConfigSnapshot.sourceConfig ?? managedConfigSnapshot.config,
              env: managedEnv,
            }
          : undefined,
      managedServiceRootRedirect: params.managedServiceRootRedirect,
    });
  };
  const getOwnedManagedUpdateEnv = () =>
    ownedManagedUpdateContext?.env ?? ownedManagedUpdatePreflightContext?.env;
  const recaptureCallerDatabaseSchemaContext = async () => {
    if (params.managedServiceRootRedirect) {
      return;
    }
    callerDatabaseSchemaContext = {
      ...callerDatabaseSchemaContext,
      configSnapshot: await recaptureCallerUpdateConfig({
        expected: callerDatabaseSchemaContext.configSnapshot,
        env: callerDatabaseSchemaContext.env,
      }),
    };
  };
  const recaptureFinalDatabaseSchemaContexts = async () => {
    await recaptureCallerDatabaseSchemaContext();
    const managedContext = ownedManagedUpdateContext ?? ownedManagedUpdatePreflightContext;
    if (!managedContext) {
      return;
    }
    const configSnapshot = await recaptureOwnedManagedUpdateConfig({
      expected: managedContext.configSnapshot,
      env: managedContext.env,
    });
    if (ownedManagedUpdateContext) {
      ownedManagedUpdateContext = { ...ownedManagedUpdateContext, configSnapshot };
    } else if (ownedManagedUpdatePreflightContext) {
      ownedManagedUpdatePreflightContext = {
        ...ownedManagedUpdatePreflightContext,
        configSnapshot,
      };
    }
  };
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  const originalRecovery = () =>
    params.installKind === "git"
      ? readCurrentGitUpdateRecovery(params.root)
      : verifyPackageUpdateRecovery(params.root);
  const recoverStoppedService = async () =>
    maybeRestartServiceAfterFailedMutableUpdate({
      recovery: await originalRecovery(),
      preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
      nodeRunner: params.packageUpdateNodeRunner,
      timeoutMs: params.updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
    });
  const gitMutationRoots =
    params.updateInstallKind === "git"
      ? params.switchToGit
        ? [params.root, resolveGitInstallDir()]
        : [params.root]
      : null;
  const stopManagedServiceBeforeMutableUpdate = async (
    mutationRoots: readonly string[] = [params.root],
    phase: "inspect" | "prepare" = "prepare",
  ) => {
    if (params.updateInstallKind !== "package" && params.updateInstallKind !== "git") {
      return;
    }
    try {
      const uniqueMutationRoots = Array.from(new Set(mutationRoots));
      for (const mutationRoot of uniqueMutationRoots) {
        const inspectedVerdict = inspectedOwnedManagedUpdatePreflightStop?.serviceUpdateVerdict;
        const expectedService =
          phase === "prepare" &&
          inspectedVerdict?.kind === "owned" &&
          inspectedVerdict.root === mutationRoot
            ? inspectedOwnedManagedUpdatePreflightStop
            : undefined;
        preManagedServiceStop = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: params.updateInstallKind,
          root: mutationRoot,
          shouldRestart: params.shouldRestart,
          jsonMode: Boolean(params.opts.json),
          timeoutMs: params.updateStepTimeoutMs,
          phase,
          handoffFromGateway: (state) =>
            handoffUpdateFromGateway({
              state,
              root: mutationRoot,
              opts: params.opts,
              // Pin the inspected package. Extended-stable resolves its protected
              // selector again because its public CLI contract forbids --tag.
              tag:
                params.updateInstallKind === "package" && params.channel !== "extended-stable"
                  ? (normalizeTag(params.packageInstallSpec) ?? undefined)
                  : undefined,
              mode:
                params.updateInstallKind === "git"
                  ? "git"
                  : (params.packageInstallTarget?.manager ?? "unknown"),
              timeoutMs: params.updateStepTimeoutMs,
              devTarget: params.devTarget,
              nodeRunner: params.packageUpdateNodeRunner,
              invocationCwd: params.invocationCwd,
              stopProgress: params.stop,
            }),
          expectedService,
        });
        if (
          phase === "inspect" &&
          !inspectedOwnedManagedUpdatePreflightStop &&
          preManagedServiceStop.serviceUpdateVerdict?.kind === "owned"
        ) {
          inspectedOwnedManagedUpdatePreflightStop = preManagedServiceStop;
        }
        if (preManagedServiceStop.windowsTaskAutoStartRecovery) {
          params.recoveryState.windowsTaskAutoStartRecovery =
            preManagedServiceStop.windowsTaskAutoStartRecovery;
        }
        if (
          preManagedServiceStop.stopped ||
          preManagedServiceStop.blockMessage ||
          shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) ||
          !preManagedServiceStop.inspected ||
          !preManagedServiceStop.running ||
          !params.shouldRestart
        ) {
          break;
        }
      }
    } catch (err) {
      if (err instanceof ScheduledTaskAutoStartRecoveryError) {
        recoveryEnv = err.serviceEnv;
        params.recoveryState.triageTarget.env = err.serviceEnv;
        throw err;
      }
      if (err instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", err.message);
      }
      if (err instanceof UpdateCommandAbort || err instanceof UpdatePreMutationError) {
        throw err;
      }
      params.stop();
      throw new Error(`Failed to stop managed gateway service before update: ${String(err)}`, {
        cause: err,
      });
    }

    if (phase === "inspect" && preManagedServiceStop?.serviceUpdateVerdict?.kind === "foreign") {
      preManagedServiceStop = undefined;
    }

    try {
      if (phase === "inspect") {
        ownedManagedUpdatePreflightContext = await captureOwnedManagedUpdatePreflightContext({
          stopState: inspectedOwnedManagedUpdatePreflightStop ?? preManagedServiceStop,
          processEnv: process.env,
          invocationCwd: params.invocationCwd,
        });
        if (ownedManagedUpdatePreflightContext) {
          params.recoveryState.triageTarget.env = ownedManagedUpdatePreflightContext.env;
        }
      } else {
        ownedManagedUpdateContext = await captureOwnedManagedUpdateContext({
          stopState: preManagedServiceStop,
          processEnv: process.env,
          invocationCwd: params.invocationCwd,
        });
        if (ownedManagedUpdateContext) {
          params.recoveryState.triageTarget.env = ownedManagedUpdateContext.env;
        }
      }
    } catch (err) {
      params.stop();
      await recoverStoppedService();
      if (err instanceof UpdatePreMutationError) {
        throw err;
      }
      throw new Error(`Failed to capture managed gateway update state: ${String(err)}`, {
        cause: err,
      });
    }

    const gatewayProcessBlock =
      shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) &&
      (phase !== "inspect" ||
        !preManagedServiceStop?.inspected ||
        preManagedServiceStop.serviceUpdateVerdict?.kind === "unavailable");
    if (preManagedServiceStop?.blockMessage) {
      const message =
        gatewayProcessBlock && preManagedServiceStop.serviceUpdateVerdict?.kind === "unavailable"
          ? formatUpdateGatewayServiceProcessBlockMessage(
              params.updateInstallKind === "git" ? "Git updates" : "Package updates",
            )
          : formatUpdateAncestryBlockMessage(preManagedServiceStop.blockMessage);
      params.stop();
      throw new UpdatePreMutationError("managed-service-preflight", message);
    }

    if (gatewayProcessBlock) {
      params.stop();
      const updateLabel = params.updateInstallKind === "git" ? "Git updates" : "Package updates";
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateGatewayServiceProcessBlockMessage(updateLabel),
      );
    }
  };

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  try {
    if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? undefined, "inspect");
    }
    const preStopPackageSchemaPreflight =
      params.updateInstallKind === "package"
        ? checkTargetDatabaseSchemasForContexts(
            params.packageTargetSchemaVersions,
            getTargetDatabaseSchemaContexts(),
          )
        : { incompatible: [], indeterminate: [] };
    if (hasSchemaRefusal(preStopPackageSchemaPreflight)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(preStopPackageSchemaPreflight).join("\n"),
      );
    }
    if (params.updateInstallKind === "package") {
      await stopManagedServiceBeforeMutableUpdate();
      await recaptureFinalDatabaseSchemaContexts();
      const postStopPackageSchemaPreflight = checkTargetDatabaseSchemasForContexts(
        params.packageTargetSchemaVersions,
        getTargetDatabaseSchemaContexts(),
      );
      if (hasSchemaRefusal(postStopPackageSchemaPreflight)) {
        throw new UpdatePreMutationError(
          "database-schema-preflight",
          formatSchemaRefusalLines(postStopPackageSchemaPreflight).join("\n"),
        );
      }
      await params.prepareMutableUpdate(getOwnedManagedUpdateEnv());
    }
    preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    result =
      params.updateInstallKind === "package"
        ? await runPackageInstallUpdate({
            root: params.root,
            installKind: params.installKind,
            tag: params.tag,
            installSpec: params.packageInstallSpec ?? undefined,
            timeoutMs: params.updateStepTimeoutMs,
            startedAt: params.startedAt,
            progress: params.progress,
            jsonMode: Boolean(params.opts.json),
            ...resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart),
            managedServiceEnv: preManagedServiceStop?.serviceEnv,
            invocationCwd: params.invocationCwd,
            honorPackageRoot:
              params.managedServiceRootRedirect !== null ||
              params.managedServiceNodeRunner !== undefined,
            nodeRunner: params.packageUpdateNodeRunner,
            installEnv: params.packageInstallEnv,
            installTarget: params.packageInstallTarget,
          })
        : await updateGitInstall({
            root: params.root,
            switchToGit: params.switchToGit,
            installKind: params.installKind,
            timeoutMs: params.timeoutMs,
            startedAt: params.startedAt,
            progress: params.progress,
            channel: params.channel,
            tag: params.tag,
            devTarget: params.devTarget,
            beforeGitMutation:
              params.updateInstallKind === "git"
                ? createBeforeGitMutation({
                    roots: gitMutationRoots ?? [params.root],
                    shouldRestart: params.shouldRestart,
                    stopManagedService: stopManagedServiceBeforeMutableUpdate,
                    getPreManagedServiceStop: () => preManagedServiceStop,
                    getDatabaseSchemaContexts: getTargetDatabaseSchemaContexts,
                    recaptureFinalDatabaseSchemaContexts,
                    prepareMutableUpdate: () =>
                      params.prepareMutableUpdate(getOwnedManagedUpdateEnv()),
                    switchToGit: params.switchToGit,
                  })
                : undefined,
            allowGatewayServiceRepair: false,
            allowGatewayActivation: false,
          });
  } catch (err) {
    params.stop();
    if (err instanceof UpdateCommandAbort) {
      return null;
    }
    const preMutationFailure = err instanceof UpdatePreMutationError;
    const message = formatErrorMessage(err);
    failure = { cause: err, detail: message };
    defaultRuntime.error(message);
    const durationMs = Date.now() - params.startedAt;
    // Only an explicit pre-mutation refusal can recover the original runtime.
    // An exception after entering mutable work carries an unsafe observed outcome
    // through the same cleanup, report, and triage path as a failed update step.
    result = {
      status: "error",
      mode:
        params.updateInstallKind === "git"
          ? "git"
          : (params.packageInstallTarget?.manager ?? "unknown"),
      root: params.root,
      reason: preMutationFailure ? err.reason : "update-failed",
      recovery: preMutationFailure
        ? await originalRecovery()
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [
        {
          name: preMutationFailure ? err.reason : "update",
          command: "openclaw update",
          cwd: params.root,
          durationMs,
          exitCode: 1,
          stderrTail: message,
        },
      ],
      durationMs,
    };
  }

  return { result, failure, preManagedServiceStop, ownedManagedUpdateContext, recoveryEnv };
}
