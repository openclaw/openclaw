import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import { normalizeUpdatePostInstallDoctorWarnings } from "../../infra/update-doctor-result.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { parseUpdateTimeoutMs, readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import { preparePostCorePluginConfig } from "./update-command-config.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import {
  collectPostCorePluginAdvisories,
  collectPostCorePluginFailureFacts,
} from "./update-command-plugins-internals.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  shouldResumePostCoreUpdateInFreshProcess,
} from "./update-command-post-core.js";
import { convergePostCoreUpdatePlugins } from "./update-command-resume.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

export async function convergeUpdatePlugins(params: {
  coreAlreadyCurrent?: boolean;
  /** Local running-code context, never installation state or mutation authority. */
  candidateRuntime?: boolean;
  result: UpdateRunResult;
  root: string;
  previousInstallRoot?: string;
  installKindChanged: boolean;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  channel: UpdateChannel;
  downgradeRisk: boolean;
  opts: UpdateCommandOptions;
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv;
  preUpdatePluginInstallRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  startedAt: number;
  packageUpdateNodeRunner?: string;
  updateStepTimeoutMs: number;
  beforeDoctor?: () => Promise<void>;
  beforeRuntimePublication?: () => Promise<void>;
  assertCurrent?: () => void;
}): Promise<{
  resultWithPostUpdate: UpdateRunResult;
  postUpdateConfigSnapshot?: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  detail?: string;
  cancelled?: boolean;
}> {
  // The finalizer also fences replacement of the original run and executor objects.
  const assertCurrent = params.assertCurrent ?? params.opts.run?.executorFence?.assertCurrent;
  assertCurrent?.();
  const postUpdateRoot = params.result.root ?? params.root;
  // Uncommitted target finalization cannot authorize a detached helper restart.
  const failedTargetRuntime = (): UpdateRunResult => ({
    ...params.result,
    status: "error",
    reason: "post-core-update-failed",
    recovery:
      params.result.recovery?.serviceRestartSafe === false
        ? params.result.recovery
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
  });
  const preUpdateConfig = params.configSnapshot.valid
    ? {
        sourceConfig: params.configSnapshot.sourceConfig,
        authoredConfig: isRecord(params.configSnapshot.parsed)
          ? (params.configSnapshot.parsed as OpenClawConfig) // SAFETY: valid snapshot validated this authored record.
          : params.configSnapshot.sourceConfig,
      }
    : undefined;

  const postUpdateInstalledVersion = await readPackageVersion(postUpdateRoot);
  assertCurrent?.();
  const versionComparison =
    postUpdateInstalledVersion && VERSION
      ? compareSemverStrings(VERSION, postUpdateInstalledVersion)
      : null;
  const runtimeRootChanged = !updateInstallRootsMatch(
    params.previousInstallRoot ?? params.root,
    postUpdateRoot,
  );
  const retainedDifferentRuntime =
    params.coreAlreadyCurrent === true &&
    (runtimeRootChanged || (versionComparison !== null && versionComparison !== 0));
  const shouldResumePostCoreInFreshProcess =
    (!params.coreAlreadyCurrent || retainedDifferentRuntime) &&
    !params.candidateRuntime &&
    shouldResumePostCoreUpdateInFreshProcess({
      // An already-current install can still differ from the retained updater.
      // Route by that runtime transition without changing the reported core result.
      result: retainedDifferentRuntime
        ? {
            ...params.result,
            status: "ok",
            before: { ...params.result.before, version: VERSION },
            after: { ...params.result.after, version: postUpdateInstalledVersion },
          }
        : params.result,
      downgradeRisk: params.downgradeRisk || (versionComparison !== null && versionComparison > 0),
      installKindChanged:
        params.installKindChanged || (retainedDifferentRuntime && runtimeRootChanged),
    });

  let postUpdateConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
  if (
    params.requestedChannel &&
    params.configSnapshot.valid &&
    params.requestedChannel !== params.storedChannel &&
    !params.opts.json
  ) {
    const verb = shouldResumePostCoreInFreshProcess ? "will be set" : "set";
    defaultRuntime.log(theme.muted(`Update channel ${verb} to ${params.requestedChannel}.`));
  }

  if (params.opts.run) {
    // Track convergence without advancing the monotonic run phase past restart.
    // The service verifier owns "verifying" after the final activation.
    recordUpdateRunStep(
      params.opts.run.runId,
      {
        step: "post-update verification",
        status: "in_progress",
        startedAtMs: Date.now(),
      },
      { env: params.opts.run.env },
    );
  }

  return await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () => {
    const previousCompatibilityHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    const compatibilityHostVersion = params.candidateRuntime
      ? (postUpdateInstalledVersion ?? VERSION)
      : versionComparison != null && versionComparison > 0
        ? postUpdateInstalledVersion
        : null;
    if (compatibilityHostVersion) {
      // Downgraded parents and candidate workers both use the installed target,
      // not a pre-update VERSION or an inherited compatibility-host override.
      process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatibilityHostVersion;
    }
    try {
      let postCorePluginUpdate;
      const doctorWarnings: string[] = [];
      const collectDoctorWarnings = (warnings: string[]) => {
        doctorWarnings.push(...warnings);
      };
      let targetRuntimeConverged = false;
      const runtimeStartedAt = Date.now();
      const runtime = await withPluginLifecycleLease({ assertCurrent }, (lease) =>
        completeSourceUpdateRuntime({
          root: postUpdateRoot,
          timeoutMs: params.updateStepTimeoutMs,
          lease,
          beforePersistentEffect: assertCurrent,
          beforePublication: params.beforeRuntimePublication,
        }),
      );
      const runtimeDurationMs = Math.max(0, Date.now() - runtimeStartedAt);
      assertCurrent?.();
      if (params.candidateRuntime) {
        // Migrated finalization already runs candidate code under the parent's
        // live grant. Reuse resume's phase without attempting nested delegation.
        const phase = await convergePostCoreUpdatePlugins({
          root: postUpdateRoot,
          channel: params.channel,
          requestedChannel: params.requestedChannel,
          opts: params.opts,
          timeoutMs: params.updateStepTimeoutMs,
          preUpdateConfig,
          parentPluginInstallRecords: params.preUpdatePluginInstallRecords,
          updateStartedAtMs: params.startedAt,
          beforeDoctor: params.beforeDoctor,
          onWarnings: collectDoctorWarnings,
          assertCurrent,
        });
        postCorePluginUpdate = phase.pluginUpdate;
        postUpdateConfigSnapshot = phase.configSnapshot;
        targetRuntimeConverged = true;
      } else if (shouldResumePostCoreInFreshProcess) {
        if (retainedDifferentRuntime && params.opts.run?.completionOwner === "gateway-restart") {
          await params.beforeDoctor?.();
          assertCurrent?.();
        }
        const freshProcessResult = await continuePostCoreUpdateInFreshProcess({
          root: postUpdateRoot,
          channel: params.channel,
          requestedChannel: params.requestedChannel,
          opts: params.opts,
          pluginInstallRecords: params.preUpdatePluginInstallRecords,
          updateStartedAtMs: params.startedAt,
          timeoutMs: params.updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
          preUpdateConfig,
        });
        assertCurrent?.();
        if (freshProcessResult.exitCode !== undefined) {
          return {
            resultWithPostUpdate: {
              ...failedTargetRuntime(),
              ...(freshProcessResult.failureFacts?.length
                ? {
                    steps: [
                      ...params.result.steps,
                      {
                        name: "post-update verification",
                        command: "openclaw update",
                        cwd: postUpdateRoot,
                        durationMs: 0,
                        exitCode: freshProcessResult.exitCode,
                        stderrTail: freshProcessResult.error,
                        failureFacts: freshProcessResult.failureFacts,
                      },
                    ],
                  }
                : {}),
            },
            detail: freshProcessResult.error,
            cancelled: freshProcessResult.exitCode === 130 || freshProcessResult.exitCode === 143,
          };
        }
        targetRuntimeConverged = freshProcessResult.resumed;
        postCorePluginUpdate = freshProcessResult.pluginUpdate;
      }

      if (retainedDifferentRuntime && !targetRuntimeConverged) {
        return {
          resultWithPostUpdate: failedTargetRuntime(),
          detail:
            "The installed target could not resume plugin convergence. Run openclaw update using the installed target executable.",
        };
      }

      if (!targetRuntimeConverged) {
        postCorePluginUpdate = await withPluginLifecycleLease({ assertCurrent }, async () => {
          const preparedConfig = await preparePostCorePluginConfig({
            requestedChannel: params.requestedChannel,
            preUpdateConfig,
            suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
            ...(assertCurrent ? { observe: false } : {}),
            assertCurrent,
          });
          assertCurrent?.();
          postUpdateConfigSnapshot = preparedConfig.configSnapshot;
          const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
          assertCurrent?.();
          return await updatePluginsAfterCoreUpdate({
            root: postUpdateRoot,
            channel: params.channel,
            ...preparedConfig,
            json: params.opts.json,
            acceptCapabilities: params.opts.acceptCapabilities,
            timeoutMs: params.updateStepTimeoutMs,
            workTimeoutMs: parseUpdateTimeoutMs(params.opts.timeout) ?? null,
            pluginInstallRecords,
            assertCurrent,
          });
        });
      }
      assertCurrent?.();

      if (postCorePluginUpdate && (!params.coreAlreadyCurrent || postCorePluginUpdate.changed)) {
        // Release the plugin lease before fresh Doctor. The finalizer either
        // retains its stopped interval or parks an already-current core here.
        const completedPluginUpdate = await completePostCorePluginUpdate({
          root: postUpdateRoot,
          opts: params.opts,
          ...(params.candidateRuntime ? { doctorConfigWrites: true as const } : {}),
          pluginUpdate: postCorePluginUpdate,
          freshDoctorRequired: postCorePluginUpdate.changed,
          beforeDoctor: params.beforeDoctor,
          assertCurrent,
          yes: params.opts.yes === true,
          json: params.opts.json === true,
          timeoutMs: params.updateStepTimeoutMs,
          onWarnings: collectDoctorWarnings,
          ...(params.packageUpdateNodeRunner ? { nodeRunner: params.packageUpdateNodeRunner } : {}),
        });
        assertCurrent?.();
        postCorePluginUpdate = completedPluginUpdate.pluginUpdate;
        postUpdateConfigSnapshot = completedPluginUpdate.configSnapshot;
      }
      assertCurrent?.();

      const resultWithPostUpdate: UpdateRunResult = {
        ...params.result,
        steps: [
          ...params.result.steps,
          ...(runtime.changed
            ? [
                {
                  name: "source runtime publication",
                  command: "openclaw update",
                  cwd: postUpdateRoot,
                  durationMs: runtimeDurationMs,
                  exitCode: 0,
                },
              ]
            : []),
        ],
        ...(postCorePluginUpdate
          ? {
              status: postCorePluginUpdate.status === "error" ? "error" : params.result.status,
              ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
              postUpdate: {
                ...params.result.postUpdate,
                plugins: postCorePluginUpdate,
              },
            }
          : {}),
      };
      const failureFacts = postCorePluginUpdate
        ? collectPostCorePluginFailureFacts(postCorePluginUpdate)
        : [];
      if (failureFacts.length) {
        resultWithPostUpdate.steps.push({
          name: "post-update verification",
          command: "openclaw plugins update",
          cwd: postUpdateRoot,
          durationMs: 0,
          exitCode: 1,
          failureFacts,
        });
      }
      resultWithPostUpdate.steps.push(
        ...normalizeUpdatePostInstallDoctorWarnings(doctorWarnings).map((message, index) => ({
          name: `post-plugin-doctor-warning-${index + 1}`,
          command: "openclaw doctor --fix",
          cwd: postUpdateRoot,
          durationMs: 0,
          exitCode: 0,
          advisory: { kind: "package-post-install-doctor" as const, message },
        })),
      );
      resultWithPostUpdate.steps.push(
        ...collectPostCorePluginAdvisories(postCorePluginUpdate).map((message, index) => ({
          name: `finalize:plugins:${index}`,
          command: "openclaw plugins update",
          cwd: postUpdateRoot,
          durationMs: 0,
          exitCode: 0,
          advisory: { kind: "recoverable-maintenance" as const, message },
        })),
      );
      if (
        params.coreAlreadyCurrent &&
        resultWithPostUpdate.status !== "error" &&
        (runtime.changed ||
          postCorePluginUpdate?.changed ||
          (retainedDifferentRuntime && params.opts.run?.gatewayRestartRequired) ||
          (params.requestedChannel !== null && params.requestedChannel !== params.storedChannel))
      ) {
        resultWithPostUpdate.status = "ok";
        delete resultWithPostUpdate.reason;
      }
      if (params.opts.run) {
        for (const step of resultWithPostUpdate.steps.flatMap(updateRunStepsFromResultStep)) {
          if (step.step.startsWith("warning:")) {
            recordUpdateRunStep(params.opts.run.runId, step, { env: params.opts.run.env });
          }
        }
        recordUpdateRunStep(
          params.opts.run.runId,
          {
            step: "post-update verification",
            status: postCorePluginUpdate?.status === "error" ? "failed" : "completed",
            endedAtMs: Date.now(),
            ...(failureFacts.length ? { failureFacts } : {}),
          },
          { env: params.opts.run.env },
        );
      }

      return { resultWithPostUpdate, postUpdateConfigSnapshot };
    } finally {
      if (compatibilityHostVersion) {
        if (previousCompatibilityHostVersion === undefined) {
          delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
        } else {
          process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousCompatibilityHostVersion;
        }
      }
    }
  });
}
