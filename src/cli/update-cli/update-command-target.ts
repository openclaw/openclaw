import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check-package-target.js";
import {
  compareSemverStrings,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  isPackageTargetAlreadyCurrent,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { VERSION } from "../../version.js";
import {
  DEFAULT_PACKAGE_NAME,
  normalizeTag,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveTargetVersion,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import { readUpdateChannelConfig } from "./update-command-config.js";
import {
  captureUpdateCommandExecutorAuthority,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import { UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import {
  failUpdateCommandRun,
  assertUpdatePackageActivationAdmission,
  readDevUpdateTarget,
  type prepareUpdateCommand,
} from "./update-command-run.js";
import {
  resolveManagedServicePackageUpdatePlan,
  formatManagedServicePackageUpdatePlan,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";

export async function resolveUpdateCommandTarget(
  opts: UpdateCommandOptions,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>,
  executor: UpdateCommandExecutor,
  updateStepTimeoutMs: number,
) {
  const {
    discoveredRoot,
    installKind,
    requestedChannel,
    controlPlaneUpdateSentinelMeta,
    timeoutMs,
  } = prepared;
  let { devTarget } = prepared;
  let root = discoveredRoot;
  let updateInstallKind = installKind;
  const refuseUpdate = async (reason: string, message?: string) => {
    const report = {
      root,
      installKind: updateInstallKind,
      reason,
      message,
      opts,
      controlPlaneUpdateSentinelMeta,
    };
    if (!opts.run && !opts.dryRun) {
      throw new UnreportedUpdateAdmissionOutcome(report);
    }
    return await reportPreMutationUpdateResult(report);
  };

  if (requestedChannel === "extended-stable" && installKind === "git") {
    await refuseUpdate("unsupported_git_channel");
    return undefined;
  }

  const { configSnapshot, legacyConfigPlan, storedChannel } = await readUpdateChannelConfig(
    Boolean(opts.channel),
  );

  if (opts.channel && !configSnapshot.valid && !legacyConfigPlan) {
    const issues = formatConfigIssueLines(configSnapshot.issues, "-");
    await refuseUpdate(
      "invalid-config",
      ["Config is invalid; cannot set update channel.", ...issues].join("\n"),
    );
    return undefined;
  }

  const channel =
    requestedChannel ??
    storedChannel ??
    (installKind === "git"
      ? DEFAULT_GIT_CHANNEL
      : resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          installKind,
        }).channel);
  if (channel === "extended-stable" && installKind === "git") {
    await refuseUpdate("unsupported_git_channel");
    return undefined;
  }
  // An effective dev channel (stored or explicit) selects the git flow — the
  // documented dev contract is a git checkout. Exception: --tag is a one-run
  // package-target override, so it keeps a stored-dev package install on the
  // package path; only an explicitly requested dev channel outranks it.
  const explicitTag = normalizeTag(opts.tag);
  const switchToGit =
    installKind !== "git" &&
    (requestedChannel === "dev" || (channel === "dev" && explicitTag === null));
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  if (channel === "dev" && requestedChannel !== "dev") {
    try {
      devTarget = readDevUpdateTarget();
    } catch (error) {
      if (!opts.run && !opts.dryRun) {
        await refuseUpdate("invalid-dev-target", formatErrorMessage(error));
      }
      if (opts.run) {
        failUpdateCommandRun(error, opts.run);
      }
      defaultRuntime.error(formatErrorMessage(error));
      defaultRuntime.exit(1);
      return undefined;
    }
  }

  const unsupportedMainTag = updateInstallKind === "package" && explicitTag === "main";
  if ((channel === "extended-stable" && explicitTag) || unsupportedMainTag) {
    await refuseUpdate(
      unsupportedMainTag ? "unsupported-package-target" : EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
      unsupportedMainTag
        ? "`--tag main` cannot update a package install. Run `openclaw update --channel dev` to switch to the supported Git checkout and build flow."
        : undefined,
    );
    return undefined;
  }
  let tag = explicitTag ?? channelToNpmTag(channel);
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  let downgradeRisk = false;
  let fallbackToLatest = false;
  let packageInstallSpec: string | null = null;
  let packageInstallEnv: NodeJS.ProcessEnv | undefined;
  let packageInstallTarget: ResolvedGlobalInstallTarget | undefined;
  let installedPackageName = DEFAULT_PACKAGE_NAME;
  let packageAlreadyCurrent = false;
  let packageTargetSchemaVersions: OpenClawSchemaVersions | undefined;
  let packageRuntimeTarget: { version: string; nodeEngine: string | null } | undefined;
  let managedServiceRootRedirect: ManagedServiceRootRedirect | null = null;
  // The service's Node can differ even when its package root matches the shell.
  let managedServiceNodeRunner: string | undefined;
  let packageUpdateNodeRunner: string | undefined;

  if (updateInstallKind === "package") {
    const servicePlan =
      prepared.servicePlan ?? (await resolveManagedServicePackageUpdatePlan({ root }));
    managedServiceRootRedirect = servicePlan.rootRedirect;
    managedServiceNodeRunner = servicePlan.nodeRunner;
    if (managedServiceRootRedirect) {
      root = managedServiceRootRedirect.root;
    }
    if (!opts.json) {
      for (const { level, message } of formatManagedServicePackageUpdatePlan(servicePlan)) {
        defaultRuntime.log(theme[level](message));
      }
    }
    packageUpdateNodeRunner = managedServiceNodeRunner;
  }

  // Read-only native/root admission is complete. Own interruption settlement
  // before metadata can block, but defer mutable housekeeping until target admission.
  if (updateInstallKind === "package" && !opts.dryRun) {
    assertUpdatePackageActivationAdmission(root);
    const fence = await executor.enter(root, { preflight: true });
    if (opts.run) {
      opts.run.executorFence = fence;
    }
    fence.assertCurrent();
    assertUpdatePackageActivationAdmission(captureUpdateCommandExecutorAuthority(fence).installKey);
  }

  if (updateInstallKind !== "git") {
    recoveryState.triageTarget.root = root;
    recoveryState.triageTarget.nodeRunner = packageUpdateNodeRunner;
    packageInstallEnv = await createGlobalInstallEnv();
    if (updateInstallKind === "package") {
      installedPackageName = (await readPackageName(root)) ?? DEFAULT_PACKAGE_NAME;
      const manager = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: updateStepTimeoutMs,
      }).catch(async (error: unknown) => {
        if (!(error instanceof UpdatePreMutationError)) {
          throw error;
        }
        const report = {
          root,
          installKind,
          reason: error.reason,
          message: error.message,
          opts,
          controlPlaneUpdateSentinelMeta,
        };
        if (!opts.run) {
          throw new UnreportedUpdateAdmissionOutcome(report, { exitCode: 0 });
        }
        return await reportPreMutationUpdateResult({ ...report, status: "skipped" });
      });
      packageInstallTarget = await resolveGlobalInstallTarget({
        manager,
        runCommand: runCommandWithTimeout,
        timeoutMs: updateStepTimeoutMs,
        pkgRoot: root,
        honorPackageRoot:
          managedServiceRootRedirect !== null || managedServiceNodeRunner !== undefined,
        packageName: installedPackageName,
      });
      const npmLifecycleGate = resolveNpmLifecyclePolicyGate(packageInstallTarget);
      if (npmLifecycleGate.error) {
        await refuseUpdate("npm lifecycle policy preflight", npmLifecycleGate.error);
        return undefined;
      }
    }
    const npmMetadataCommand =
      packageInstallTarget?.manager === "npm" ? packageInstallTarget.command : undefined;
    currentVersion = await readPackageVersion(root);
    if (channel === "extended-stable") {
      const extendedStable = await resolveExtendedStablePackage({
        installKind: updateInstallKind,
        timeoutMs,
        packageName: installedPackageName,
      });
      if (extendedStable.status === "failed") {
        await refuseUpdate(extendedStable.reason);
        return undefined;
      }
      targetVersion = extendedStable.version;
      tag = extendedStable.version;
      packageInstallSpec = extendedStable.packageSpec;
    } else if (explicitTag) {
      targetVersion = await resolveTargetVersion(tag, timeoutMs, {
        spec: resolveGlobalInstallSpec({
          packageName: DEFAULT_PACKAGE_NAME,
          tag,
          env: packageInstallEnv,
        }),
        command: npmMetadataCommand,
        cwd: invocationCwd,
        env: packageInstallEnv,
      });
    } else {
      targetVersion = await resolveNpmChannelTag({
        channel,
        timeoutMs,
        command: npmMetadataCommand,
        cwd: invocationCwd,
        env: packageInstallEnv,
      }).then((resolved) => {
        tag = resolved.tag;
        fallbackToLatest = channel === "beta" && resolved.tag === "latest";
        return resolved.version;
      });
    }
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    packageInstallSpec ??= resolveGlobalInstallSpec({
      packageName: DEFAULT_PACKAGE_NAME,
      tag,
      env: packageInstallEnv,
    });
    packageAlreadyCurrent =
      updateInstallKind === "package" &&
      !switchToPackage &&
      isPackageTargetAlreadyCurrent({ currentVersion, targetVersion, target: packageInstallSpec });
    downgradeRisk =
      canResolveRegistryVersionForPackageTarget(tag) &&
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null ? tag !== "latest" : cmp != null && cmp > 0);
    if (targetVersion) {
      const targetMetadata = await fetchNpmPackageTargetStatus({
        target: targetVersion,
        spec: resolveGlobalInstallSpec({
          packageName: DEFAULT_PACKAGE_NAME,
          tag: targetVersion,
          env: packageInstallEnv,
        }),
        command: npmMetadataCommand,
        timeoutMs,
        cwd: invocationCwd,
        env: packageInstallEnv,
      });
      if (targetMetadata.error || targetMetadata.version !== targetVersion) {
        await refuseUpdate(
          "target-metadata-preflight",
          `Update refused: could not inspect exact package target openclaw@${targetVersion}: ${targetMetadata.error ?? `registry returned version ${targetMetadata.version ?? "unknown"}`}.`,
        );
        return undefined;
      }
      packageTargetSchemaVersions = targetMetadata.schemaVersions;
      // Runtime and schema checks must use the same exact package that will be
      // installed; rereading a mutable dist-tag can inspect a different release.
      packageRuntimeTarget = { version: targetVersion, nodeEngine: targetMetadata.nodeEngine };
      // Always install the exact inspected version: a dist-tag can move between
      // this lookup and the install, and an uninspected version would bypass
      // the schema and runtime decisions made here. Missing schema metadata
      // only means the schema preflight cannot run (legacy target).
      if (updateInstallKind === "package" && canResolveRegistryVersionForPackageTarget(tag)) {
        packageInstallSpec = resolveGlobalInstallSpec({
          packageName: DEFAULT_PACKAGE_NAME,
          tag: targetVersion,
          env: packageInstallEnv,
        });
      }
    }
  }

  return {
    root,
    updateInstallKind,
    refuseUpdate,
    configSnapshot,
    legacyConfigPlan,
    storedChannel,
    channel,
    explicitTag,
    switchToGit,
    switchToPackage,
    tag,
    currentVersion,
    targetVersion,
    downgradeRisk,
    fallbackToLatest,
    packageInstallSpec,
    packageInstallEnv,
    packageInstallTarget,
    packageAlreadyCurrent,
    packageTargetSchemaVersions,
    packageRuntimeTarget,
    managedServiceRootRedirect,
    managedServiceNodeRunner,
    packageUpdateNodeRunner,
    devTarget,
  };
}
