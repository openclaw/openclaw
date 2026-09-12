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
import { readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import { preparePostCorePluginConfig } from "./update-command-config.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  shouldResumePostCoreUpdateInFreshProcess,
} from "./update-command-post-core.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

export async function convergeUpdatePlugins(params: {
  coreAlreadyCurrent?: boolean;
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
    const compatibilityDowngradeTarget =
      versionComparison != null && versionComparison > 0 ? postUpdateInstalledVersion : null;
    if (compatibilityDowngradeTarget) {
      // The parent still reports its pre-update VERSION. Convergence and fresh
      // completion must both use the installed target's compatibility contract.
      process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatibilityDowngradeTarget;
    }
    try {
      let postCorePluginUpdate;
      const doctorWarnings: string[] = [];
      let pluginsUpdatedInFreshProcess = false;
      if (shouldResumePostCoreInFreshProcess) {
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
              ...params.result,
              status: "error" as const,
              reason: "post-core-update-failed",
            },
            detail: freshProcessResult.error,
            cancelled: freshProcessResult.exitCode === 130 || freshProcessResult.exitCode === 143,
          };
        }
        pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
        postCorePluginUpdate = freshProcessResult.pluginUpdate;
      }

      if (retainedDifferentRuntime && !pluginsUpdatedInFreshProcess) {
        return {
          resultWithPostUpdate: {
            ...params.result,
            status: "error" as const,
            reason: "post-core-update-failed",
          },
          detail:
            "The installed target could not resume plugin convergence. Run openclaw update using the installed target executable.",
        };
      }

      if (!pluginsUpdatedInFreshProcess) {
        postCorePluginUpdate = await withPluginLifecycleLease({ assertCurrent }, async () => {
          const preparedConfig = await preparePostCorePluginConfig({
            requestedChannel: params.requestedChannel,
            preUpdateConfig,
            suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
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
          pluginUpdate: postCorePluginUpdate,
          freshDoctorRequired: postCorePluginUpdate.changed,
          beforeDoctor: params.beforeDoctor,
          yes: params.opts.yes === true,
          json: params.opts.json === true,
          timeoutMs: params.updateStepTimeoutMs,
          onWarnings: (warnings) => {
            doctorWarnings.push(...warnings);
          },
          ...(params.packageUpdateNodeRunner ? { nodeRunner: params.packageUpdateNodeRunner } : {}),
        });
        assertCurrent?.();
        postCorePluginUpdate = completedPluginUpdate.pluginUpdate;
        postUpdateConfigSnapshot = completedPluginUpdate.configSnapshot;
      }

      let resultWithPostUpdate: UpdateRunResult = postCorePluginUpdate
        ? {
            ...params.result,
            status: postCorePluginUpdate.status === "error" ? "error" : params.result.status,
            ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
            postUpdate: {
              ...params.result.postUpdate,
              plugins: postCorePluginUpdate,
            },
          }
        : params.result;
      if (doctorWarnings.length) {
        resultWithPostUpdate = {
          ...resultWithPostUpdate,
          steps: [
            ...resultWithPostUpdate.steps,
            ...normalizeUpdatePostInstallDoctorWarnings(doctorWarnings).map((message, index) => ({
              name: `post-plugin doctor warning ${index + 1}`,
              command: "openclaw doctor --fix",
              cwd: postUpdateRoot,
              durationMs: 0,
              exitCode: 0,
              advisory: { kind: "package-post-install-doctor" as const, message },
            })),
          ],
        };
      }
      const pluginAdvisories = (postCorePluginUpdate?.warnings ?? []).filter(
        (warning) => warning.reason === "plugin-target-unavailable",
      );
      resultWithPostUpdate = {
        ...resultWithPostUpdate,
        steps: [
          ...resultWithPostUpdate.steps,
          ...pluginAdvisories.map((warning, index) => ({
            name: `finalize:plugins:${index}`,
            command: "openclaw plugins update",
            cwd: postUpdateRoot,
            durationMs: 0,
            exitCode: 0,
            advisory: { kind: "recoverable-maintenance" as const, message: warning.message },
          })),
        ],
      };
      if (
        params.coreAlreadyCurrent &&
        resultWithPostUpdate.status !== "error" &&
        (postCorePluginUpdate?.changed ||
          (params.requestedChannel !== null && params.requestedChannel !== params.storedChannel))
      ) {
        resultWithPostUpdate = { ...resultWithPostUpdate, status: "ok" };
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
          },
          { env: params.opts.run.env },
        );
      }

      return { resultWithPostUpdate, postUpdateConfigSnapshot };
    } finally {
      if (compatibilityDowngradeTarget) {
        if (previousCompatibilityHostVersion === undefined) {
          delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
        } else {
          process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousCompatibilityHostVersion;
        }
      }
    }
  });
}
