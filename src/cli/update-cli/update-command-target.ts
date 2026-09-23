import path from "node:path";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { resolveStateDir } from "../../config/paths.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SqliteReadOnlyInspectionContentionError } from "../../infra/sqlite-readonly-worker-protocol.js";
import { assessInitialUpdateSnapshotCapacity } from "../../infra/update-candidate-snapshot.js";
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
import { createFreeBsdPkgOwnershipInspection } from "../../infra/update-freebsd-pkg-ownership.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  isPackageTargetAlreadyCurrent,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import {
  describeUpdateInstallRoot,
  resolveUnmanagedUpdateInstallReason,
  resolveUpdateInstallSurface,
} from "../../infra/update-runner-install-surface.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { VERSION } from "../../version.js";
import { CLI_NAME } from "../cli-name.js";
import {
  DEFAULT_PACKAGE_NAME,
  normalizeTag,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import { readUpdateChannelConfig } from "./update-command-config.js";
import {
  captureUpdateCommandExecutorAuthority,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import { readUpdateCandidateSource } from "./update-command-managed-context.js";
import { inspectNpmGlobalDestination } from "./update-command-package-destination.js";
import { UnreportedUpdateAdmissionOutcome, type RefuseUpdate } from "./update-command-result.js";
import {
  assertUpdatePackageActivationAdmission,
  readDevUpdateTarget,
  recordUpdateCommandTarget,
  type prepareUpdateCommand,
} from "./update-command-run.js";
import {
  resolveManagedServicePackageUpdatePlan,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { reportPreMutationUpdateResult } from "./update-command-terminal.js";

/** A fresh profile must be initialized by an identified, schema-declaring target. */
export async function resolveFreshUpdateMetadata(target: {
  targetVersion: string | null;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  refuseUpdate: RefuseUpdate;
}) {
  if (target.targetVersion && target.packageTargetSchemaVersions) {
    return { version: target.targetVersion, schemaVersions: target.packageTargetSchemaVersions };
  }
  const failure = createUpdatePreflightFailure(
    target.targetVersion ? "target-schema-metadata" : "target-registry-dist-tag",
  );
  await target.refuseUpdate("target-metadata-preflight", failure.message, failure.failureFacts);
  return undefined;
}

/** Describe the selected plan without changing roots, runtime, or service authority. */
function formatManagedServicePackageUpdatePlan(params: {
  rootRedirect: ManagedServiceRootRedirect | null;
  serviceRoot?: string;
  nodeRunner?: string;
}): Array<{ level: "muted" | "warn"; message: string }> {
  const { rootRedirect, nodeRunner } = params;
  if (rootRedirect) {
    return [
      {
        level: "muted",
        message: `Targeting managed gateway service package root: ${rootRedirect.root}`,
      },
      {
        level: "warn",
        message: `Shell OpenClaw root differs from the managed gateway service root: ${rootRedirect.previousRoot}`,
      },
      {
        level: "muted",
        message: `After the update, make sure \`${CLI_NAME}\` on PATH resolves to the managed service root or reinstall the gateway service from the shell install you want to use.`,
      },
      ...(nodeRunner
        ? [{ level: "muted" as const, message: `Managed gateway service Node: ${nodeRunner}` }]
        : []),
    ];
  }
  if (params.serviceRoot) {
    return [
      {
        level: "muted",
        message: `Updating this installation and rebinding the managed Gateway from ${params.serviceRoot} after ownership and runtime verification.`,
      },
    ];
  }
  return nodeRunner
    ? [
        {
          level: "warn",
          message: `Current Node (${resolveNodeRunner()}) differs from the managed gateway service Node (${nodeRunner}).`,
        },
        {
          level: "muted",
          message:
            "Using the managed service Node for this update so the gateway can start after the upgrade.",
        },
      ]
    : [];
}

export async function resolveUpdateCommandTarget(
  opts: UpdateCommandOptions,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>,
  executor: UpdateCommandExecutor,
  updateStepTimeoutMs: number,
) {
  let preparingTarget = true;
  try {
    return await withCommandProcessScope(async () => {
      const {
        discoveredRoot,
        installKind,
        requestedChannel,
        controlPlaneUpdateSentinelMeta,
        timeoutMs,
      } = prepared;
      // Initialization and confirmations can outlive the earlier admission snapshot.
      const pkgOwnership = createFreeBsdPkgOwnershipInspection(updateStepTimeoutMs);
      await pkgOwnership.assertUnowned(discoveredRoot);
      let { devTarget } = prepared;
      let root = discoveredRoot;
      let updateInstallKind = installKind;
      let packageManager: ResolvedGlobalInstallTarget["manager"] | undefined;
      const resolveMode = async (): Promise<UpdateRunResult["mode"]> => {
        if (updateInstallKind === "git") {
          return "git";
        }
        if (packageManager) {
          return packageManager;
        }
        // Policy/config refusals can precede target preparation. Inspect their owner too.
        return (
          await resolveUpdateInstallSurface({
            root,
            installKind,
            timeoutMs: updateStepTimeoutMs,
            runCommand: runCommandWithTimeout,
          })
        ).mode;
      };
      const refuseUpdate: RefuseUpdate = async (reason, message, failureFacts, recoverySteps) => {
        const report = {
          root,
          installKind: updateInstallKind,
          // Invalid config refuses before manager probes; retain the known install kind.
          mode: reason === "invalid-config" ? packageManager : await resolveMode(),
          reason,
          message,
          failureFacts,
          recoverySteps,
          opts,
          controlPlaneUpdateSentinelMeta,
        };
        if (preparingTarget || (!opts.run && !opts.dryRun)) {
          throw new UnreportedUpdateAdmissionOutcome(report);
        }
        return await reportPreMutationUpdateResult(report);
      };

      if (installKind === "unknown") {
        const servicePlan = await resolveManagedServicePackageUpdatePlan({ root, pkgOwnership });
        const failure = createUpdatePreflightFailure(
          "installation-unclassified",
          `${await describeUpdateInstallRoot(root)} Service unit target: ${servicePlan.serviceUnitTarget ?? "not inspected"}.`,
        );
        throw new UnreportedUpdateAdmissionOutcome(
          {
            root,
            installKind,
            mode: "unknown",
            opts,
            controlPlaneUpdateSentinelMeta,
            reason: resolveUnmanagedUpdateInstallReason(),
            ...failure,
          },
          { exitCode: 0 },
        );
      }

      recordUpdateCommandTarget(opts.run, {
        step: { step: "installation-inspection", status: "in_progress" },
      });
      if (requestedChannel === "extended-stable" && installKind === "git") {
        await refuseUpdate("unsupported_git_channel");
        return undefined;
      }

      const readChannelConfig = () => readUpdateChannelConfig(Boolean(opts.channel));
      let channelConfig: Awaited<ReturnType<typeof readUpdateChannelConfig>>;
      let inspectionWarning: string | undefined;
      try {
        channelConfig = await readChannelConfig();
      } catch (error) {
        if (!(error instanceof SqliteReadOnlyInspectionContentionError)) {
          throw error;
        }
        channelConfig = await readChannelConfig();
        inspectionWarning = `Read-only SQLite inspection recovered after temporary contention; continuing the update. ${formatErrorMessage(error)}`;
        recordUpdateCommandTarget(opts.run, {
          step: {
            step: "warning:installation-inspection",
            status: "completed",
            detail: inspectionWarning,
          },
        });
        defaultRuntime.error(`Warning: ${inspectionWarning}`);
      }
      const { configSnapshot, legacyConfigPlan, storedChannel } = channelConfig;

      if (opts.channel && !configSnapshot.valid && !legacyConfigPlan) {
        const issues = formatConfigIssueLines(configSnapshot.issues, "-");
        await refuseUpdate(
          "invalid-config",
          ["Config is invalid; cannot set update channel.", ...issues].join("\n"),
        );
        return undefined;
      }

      const channel =
        (opts.sourceUpdate ? DEFAULT_GIT_CHANNEL : requestedChannel) ??
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
      if (channel === "dev" && requestedChannel !== "dev" && !opts.sourceUpdate) {
        try {
          devTarget = readDevUpdateTarget();
        } catch (error) {
          await refuseUpdate("invalid-dev-target", formatErrorMessage(error));
          return undefined;
        }
      }

      const unsupportedMainTag = updateInstallKind === "package" && explicitTag === "main";
      if ((channel === "extended-stable" && explicitTag) || unsupportedMainTag) {
        await refuseUpdate(
          unsupportedMainTag
            ? "unsupported-package-target"
            : EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
          unsupportedMainTag
            ? "`--tag main` cannot update a package install. Run `openclaw update --channel dev` to switch to the supported Git checkout and build flow."
            : undefined,
        );
        return undefined;
      }
      let tag = explicitTag ?? channelToNpmTag(channel);
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
      let managedServiceRoot: string | undefined;
      // The service's Node can differ even when its package root matches the shell.
      let managedServiceNodeRunner: string | undefined;
      let packageUpdateNodeRunner: string | undefined;
      let serviceUnitTarget: string | undefined;

      if (updateInstallKind === "package") {
        const servicePlan =
          prepared.servicePlan ??
          (await resolveManagedServicePackageUpdatePlan({
            root,
            pkgOwnership,
            rebind: prepared.shouldRestart,
          }));
        await pkgOwnership.assertUnowned(servicePlan.rootRedirect?.root ?? root);
        managedServiceRootRedirect = servicePlan.rootRedirect;
        serviceUnitTarget = servicePlan.serviceUnitTarget;
        managedServiceRoot = servicePlan.serviceRoot;
        managedServiceNodeRunner = servicePlan.nodeRunner;
        if (managedServiceRootRedirect) {
          root = managedServiceRootRedirect.root;
        }
        if (!opts.json) {
          for (const { level, message } of formatManagedServicePackageUpdatePlan(servicePlan)) {
            defaultRuntime.log(theme[level](message));
          }
        }
        packageUpdateNodeRunner = managedServiceRoot
          ? resolveNodeRunner()
          : managedServiceNodeRunner;
      }

      // Read-only native/root admission is complete. Own interruption settlement
      // before metadata can block, but defer mutable housekeeping until target admission.
      if (updateInstallKind === "package" && !opts.dryRun) {
        assertUpdatePackageActivationAdmission(root, { serviceRoot: managedServiceRoot });
        const fence = await executor.enter(root, {
          preflight: true,
          serviceRoot: managedServiceRoot,
        });
        if (opts.run) {
          opts.run.executorFence = fence;
        }
        fence.assertCurrent();
        assertUpdatePackageActivationAdmission(
          captureUpdateCommandExecutorAuthority(fence).installKey,
          { serviceRoot: managedServiceRoot },
        );
      }

      const currentVersion = await readPackageVersion(root);
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
            pkgOwnership,
            serviceUnitTarget,
          }).catch(async (error: unknown) => {
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            if (!(error instanceof UpdatePreMutationError)) {
              throw error;
            }
            const report = {
              root,
              installKind,
              reason: error.reason,
              message: error.message,
              failureFacts: error.failureFacts,
              opts,
              controlPlaneUpdateSentinelMeta,
            };
            throw new UnreportedUpdateAdmissionOutcome(report, { exitCode: 0 });
          });
          packageManager = manager;
          recordUpdateCommandTarget(opts.run, {
            target: { kind: updateInstallKind, tag, installationMethod: `${manager}-global` },
          });
          packageInstallTarget = await resolveGlobalInstallTarget({
            manager,
            runCommand: runCommandWithTimeout,
            timeoutMs: updateStepTimeoutMs,
            pkgRoot: root,
            honorPackageRoot:
              managedServiceRootRedirect !== null ||
              managedServiceRoot !== undefined ||
              managedServiceNodeRunner !== undefined,
            packageName: installedPackageName,
            pkgOwnership,
          });
          if (packageInstallTarget.manager === "npm") {
            const destination = await inspectNpmGlobalDestination(root, updateStepTimeoutMs);
            if (destination.kind !== "owned" && destination.kind !== "empty") {
              await refuseUpdate(destination.reason, destination.message, destination.failureFacts);
              return undefined;
            }
          }
          const diskWarning = createLowDiskSpaceWarning({
            targetPath: packageInstallTarget.packageRoot
              ? path.dirname(packageInstallTarget.packageRoot)
              : root,
            purpose: "global package update",
          });
          if (diskWarning) {
            if (opts.json) {
              defaultRuntime.error(`Warning: ${diskWarning}`);
            } else {
              defaultRuntime.log(theme.warn(diskWarning));
            }
            opts.run?.executorFence?.assertCurrent();
            for (const step of updateRunStepsFromResultStep({
              name: "disk-space-preflight",
              exitCode: 0,
              warnings: [diskWarning],
            })) {
              recordUpdateCommandTarget(opts.run, { step });
            }
          }
          const npmLifecycleGate = resolveNpmLifecyclePolicyGate(packageInstallTarget);
          if (npmLifecycleGate.error) {
            await refuseUpdate("npm lifecycle policy preflight", npmLifecycleGate.error);
            return undefined;
          }
        }
        recordUpdateCommandTarget(opts.run, {
          step: { step: "installation-inspection", status: "completed", endedAtMs: Date.now() },
        });
        recordUpdateCommandTarget(opts.run, {
          target: { kind: updateInstallKind, tag },
          step: { step: "target-resolution", status: "in_progress", startedAtMs: Date.now() },
        });
        const npmMetadataCommand =
          packageInstallTarget?.manager === "npm" ? packageInstallTarget.command : undefined;
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
          currentVersion && targetVersion
            ? compareSemverStrings(currentVersion, targetVersion)
            : null;
        packageInstallSpec ??= resolveGlobalInstallSpec({
          packageName: DEFAULT_PACKAGE_NAME,
          tag,
          env: packageInstallEnv,
        });
        packageAlreadyCurrent =
          !managedServiceRoot &&
          updateInstallKind === "package" &&
          !switchToPackage &&
          isPackageTargetAlreadyCurrent({
            currentVersion,
            targetVersion,
            target: packageInstallSpec,
          });
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
            const failure = createUpdatePreflightFailure(
              targetMetadata.error ? "target-registry-metadata" : "target-version-resolution",
              `Could not inspect exact package target openclaw@${targetVersion}: ${targetMetadata.error ?? `registry returned version ${targetMetadata.version ?? "unknown"}`}.`,
            );
            await refuseUpdate("target-metadata-preflight", failure.message, failure.failureFacts);
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

      recordUpdateCommandTarget(opts.run, {
        target: {
          kind: updateInstallKind,
          tag,
          ...(targetVersion ? { version: targetVersion } : {}),
          ...(updateInstallKind === "git" ? { installationMethod: "git-checkout" } : {}),
        },
        step: {
          step: updateInstallKind === "git" ? "installation-inspection" : "target-resolution",
          status: "completed",
          endedAtMs: Date.now(),
        },
      });
      // No-op updates need no candidate snapshot; package-space warnings remain advisory above.
      if (updateInstallKind === "package" && !packageAlreadyCurrent && !opts.dryRun) {
        const env = opts.run?.env ?? process.env;
        const source = await readUpdateCandidateSource(env, legacyConfigPlan);
        const snapshot = await assessInitialUpdateSnapshotCapacity({
          config: source.config,
          stateDir: resolveStateDir(env),
          env,
        });
        opts.run?.executorFence?.assertCurrent();
        for (const step of updateRunStepsFromResultStep(snapshot)) {
          recordUpdateCommandTarget(opts.run, { step });
        }
        if (snapshot.exitCode !== 0) {
          await refuseUpdate("snapshot-capacity-insufficient", snapshot.stderrTail ?? undefined);
          return undefined;
        }
        for (const warning of snapshot.warnings ?? []) {
          if (opts.json) {
            defaultRuntime.error(`Warning: ${warning}`);
          } else {
            defaultRuntime.log(theme.warn(warning));
          }
        }
      }

      return {
        root,
        ...(inspectionWarning ? { inspectionWarning } : {}),
        mode: await resolveMode(),
        updateInstallKind,
        refuseUpdate,
        configSnapshot,
        legacyConfigPlan,
        storedChannel,
        requestedChannel,
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
        managedServiceRoot,
        managedServiceNodeRunner,
        packageUpdateNodeRunner,
        devTarget,
      };
    });
  } catch (error) {
    if (
      !hasCommandProcessCleanupError(error) &&
      error instanceof UnreportedUpdateAdmissionOutcome &&
      (error.skipped ? opts.run : opts.run || opts.dryRun)
    ) {
      return await reportPreMutationUpdateResult({
        ...error.report,
        ...(error.skipped?.exitCode === 0 ? { status: "skipped" } : {}),
      });
    }
    throw error;
  } finally {
    preparingTarget = false;
  }
}
