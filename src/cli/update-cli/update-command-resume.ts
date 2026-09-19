import { readConfigFileSnapshot } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { hasDeferredUpdateModelRetirement } from "../../infra/update-deferred-model-retirement.js";
import {
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  type PreUpdateConfigRestoreInput,
} from "../../infra/update-post-core-context.js";
import { recordPostCoreUpdateEvidence } from "../../infra/update-run-interruption.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import {
  preparePostCorePluginConfig,
  persistValidatedDowngradeConfig,
  readPostCorePreUpdateSourceConfig,
} from "./update-command-config.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
} from "./update-command-fresh-doctor.js";
import { readPackageUpdateIdentity } from "./update-command-package.js";
import { collectPostCorePluginAdvisories } from "./update-command-plugins-internals.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import {
  postCoreUpdateParentOwnsCompletion,
  readPostCorePluginInstallRecordsFile,
  resolvePostCoreUpdateOperatorOptions,
  resolvePostCoreUpdateStartedAtMs,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";

type ResumePostCoreUpdateParams = {
  root: string;
  channel: string | undefined;
  opts: UpdateCommandOptions;
  timeoutMs: number;
};

export async function resumePostCoreUpdate(params: ResumePostCoreUpdateParams): Promise<void> {
  try {
    const opts = await resolvePostCoreUpdateOperatorOptions({
      opts: params.opts,
      resultPath: process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
    });
    await resumePostCoreUpdateInternal({ ...params, opts });
  } catch (error) {
    // Publish only after phase cleanup releases its leases. The parent owns
    // recovery and triage; inherited TTY output cannot serve as its error record.
    await writePostCoreUpdateFailureFile(
      process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
      error,
    ).catch((writeError: unknown) =>
      defaultRuntime.error(`Could not save post-update failure: ${String(writeError)}`),
    );
    throw error;
  }
}

async function resumePostCoreUpdateInternal(params: ResumePostCoreUpdateParams): Promise<void> {
  const assertCurrent = params.opts.run?.executorFence?.assertCurrent;
  assertCurrent?.();
  if (
    params.channel !== "stable" &&
    params.channel !== "extended-stable" &&
    params.channel !== "beta" &&
    params.channel !== "dev"
  ) {
    defaultRuntime.error("Missing post-core update channel context.");
    defaultRuntime.exit(1);
    return;
  }
  const channel = params.channel;

  const requestedChannelInput = process.env[POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]?.trim() ?? "";
  const requestedChannel = requestedChannelInput
    ? normalizeUpdateChannel(requestedChannelInput)
    : null;
  if (requestedChannelInput && !requestedChannel) {
    defaultRuntime.error("Invalid post-core requested update channel context.");
    defaultRuntime.exit(1);
    return;
  }

  process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION =
    (await readPackageVersion(params.root)) ?? VERSION;
  assertCurrent?.();

  const parentOwnsCompletion = await postCoreUpdateParentOwnsCompletion(
    process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
  );
  assertCurrent?.();
  await withPluginLifecycleLease({ assertCurrent }, async (lease) => {
    await completeSourceUpdateRuntime({
      root: params.root,
      timeoutMs: params.timeoutMs,
      lease,
      beforePersistentEffect: assertCurrent,
    });
  });
  assertCurrent?.();
  let maintenance: Awaited<
    ReturnType<typeof import("../../commands/doctor-maintenance.js").beginDoctorMaintenance>
  >;
  let outcome: { pluginUpdate: PostCorePluginUpdateResult } | { error: unknown };
  try {
    outcome = {
      pluginUpdate: await withCommandProcessScope(async () => {
        if (!parentOwnsCompletion) {
          const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
          assertCurrent?.();
          maintenance = await beginDoctorMaintenance({
            root: params.root,
            options: { repair: true, nonInteractive: true, json: params.opts.json },
            runtime: { ...defaultRuntime, log: defaultRuntime.error },
          });
          assertCurrent?.();
          // The parent parks the service; each fresh Doctor holds its own database fences.
          await maintenance?.releaseState();
          // Shipped parents expect the child to prepare migration plugins and settle
          // Doctor before plugin config writes; Doctor owns that preparation and its guards.
          await runUpdateFinalizationDoctorInFreshProcess({
            opts: params.opts,
            phase: "post-plugin",
            assertCurrent,
            root: params.root,
            yes: params.opts.yes === true,
            json: params.opts.json === true,
            timeoutMs: params.timeoutMs,
          });
        }

        const configSnapshot = await readConfigFileSnapshot({
          skipPluginValidation: true,
          suppressFutureVersionWarning: true,
          observe: false,
        });
        const updateStartedAtMs = await resolvePostCoreUpdateStartedAtMs(process.env);
        const preUpdateSourceConfig = await readPostCorePreUpdateSourceConfig({
          sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
          currentSnapshot: configSnapshot,
          updateStartedAtMs,
        });
        const parentPluginInstallRecords = await readPostCorePluginInstallRecordsFile(
          process.env[POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV],
        );
        assertCurrent?.();
        const { pluginUpdate } = await convergePostCoreUpdatePlugins({
          ...params,
          channel,
          requestedChannel,
          preUpdateConfig: preUpdateSourceConfig,
          parentPluginInstallRecords,
          updateStartedAtMs: process.env[POST_CORE_UPDATE_STARTED_AT_ENV]?.trim()
            ? updateStartedAtMs
            : undefined,
          parentOwnsCompletion,
          assertCurrent,
        });
        return pluginUpdate;
      }),
    };
  } catch (error) {
    outcome = { error };
  }
  // A legacy parent can terminate this child as soon as its result appears.
  // Settle child work and restore service custody before publishing either outcome.
  if (maintenance && !("error" in outcome && hasCommandProcessCleanupError(outcome.error))) {
    const owned = maintenance;
    const failures = "error" in outcome ? [outcome.error] : [];
    for (const restore of [
      async () =>
        owned.finish((await readConfigFileSnapshot({ skipPluginValidation: true })).config),
      () => owned.release(),
    ]) {
      if (failures.some(hasCommandProcessCleanupError)) {
        break;
      }
      try {
        await withCommandProcessScope(restore);
      } catch (error) {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      }
    }
    if (failures.length) {
      outcome = {
        error:
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Post-core update and service restoration failed", {
                cause: failures[0],
              }),
      };
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  const { pluginUpdate } = outcome;
  assertCurrent?.();
  const runId = process.env[UPDATE_RUN_ID_ENV]?.trim();
  if (process.env[POST_CORE_UPDATE_ENV] === "1" && runId) {
    try {
      recordPostCoreUpdateEvidence(runId, {
        candidate:
          pluginUpdate.status !== "error"
            ? await readPackageUpdateIdentity(params.root)
            : undefined,
        warnings: collectPostCorePluginAdvisories(pluginUpdate),
      });
    } catch (error) {
      defaultRuntime.error(
        `Post-core update evidence could not be saved to update history: ${formatErrorMessage(error)} Update completion may require Doctor verification.`,
      );
    }
  }
  assertCurrent?.();
  if (process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
    await writePostCorePluginUpdateResultFile(
      process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
      pluginUpdate,
    );
  }
  assertCurrent?.();
  if (params.opts.json && !process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
    const result: UpdateRunResult = {
      status: pluginUpdate.status === "error" ? "error" : "ok",
      mode: "unknown",
      root: params.root,
      steps: [],
      durationMs: 0,
      postUpdate: { plugins: pluginUpdate },
    };
    defaultRuntime.writeJson(result);
  }
  defaultRuntime.exit(0);
}

/** Candidate code owns this phase whether reached by CLI resume or migrated finalization. */
export async function convergePostCoreUpdatePlugins(params: {
  root: string;
  channel: UpdateChannel;
  requestedChannel: UpdateChannel | null;
  opts: UpdateCommandOptions;
  timeoutMs: number;
  preUpdateConfig?: PreUpdateConfigRestoreInput;
  parentPluginInstallRecords?: Record<string, PluginInstallRecord>;
  /** Only an explicitly forwarded update start makes an empty index authoritative. */
  updateStartedAtMs?: number;
  /** Modern parents finalize after consuming the result; legacy children finalize before publication. */
  parentOwnsCompletion?: boolean;
  assertCurrent?: () => void;
}) {
  const { assertCurrent } = params;
  assertCurrent?.();
  const producedPluginUpdate = await withPluginLifecycleLease({ assertCurrent }, async () => {
    // Entry points complete runtime artifacts and any legacy pre-convergence
    // Doctor before capturing config. This phase consumes that committed generation.
    const preparedConfig = await preparePostCorePluginConfig({
      requestedChannel: params.requestedChannel,
      preUpdateConfig: params.preUpdateConfig,
      suppressFutureVersionWarning: true,
      observe: false,
      assertCurrent,
    });
    // The updated doctor may have repaired or removed plugin installs before this process resumed.
    const currentPluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    const persistedPluginIndex = await readPersistedInstalledPluginIndex();
    assertCurrent?.();
    const currentIndexIsAuthoritative =
      Object.keys(currentPluginInstallRecords).length > 0 ||
      Boolean(
        persistedPluginIndex &&
        params.updateStartedAtMs !== undefined &&
        persistedPluginIndex.generatedAtMs >= params.updateStartedAtMs,
      );
    const pluginInstallRecords = currentIndexIsAuthoritative
      ? currentPluginInstallRecords
      : params.parentPluginInstallRecords;

    return await updatePluginsAfterCoreUpdate({
      root: params.root,
      channel: params.channel,
      ...preparedConfig,
      json: params.opts.json,
      acceptCapabilities: params.opts.acceptCapabilities,
      timeoutMs: params.timeoutMs,
      pluginInstallRecords,
      assertCurrent,
    });
  });
  assertCurrent?.();
  // Release plugin ownership before Doctor reacquires it. Legacy parents may
  // stop this child as soon as its result appears, so their completion stays here.
  const pluginUpdate =
    params.parentOwnsCompletion === false ||
    (!producedPluginUpdate.changed && hasDeferredUpdateModelRetirement())
      ? (
          await completePostCorePluginUpdate({
            root: params.root,
            opts: params.opts,
            pluginUpdate: producedPluginUpdate,
            freshDoctorRequired: producedPluginUpdate.changed,
            assertCurrent,
            yes: params.opts.yes === true,
            json: params.opts.json === true,
            timeoutMs: params.timeoutMs,
          })
        ).pluginUpdate
      : producedPluginUpdate;
  assertCurrent?.();
  // Only the target process may restamp an unchanged downgrade config. Plugin
  // migrations that still invalidate it will write through the target Doctor later.
  const finalSnapshot = await readConfigFileSnapshot({ observe: false });
  assertCurrent?.();
  await persistValidatedDowngradeConfig(finalSnapshot, assertCurrent);
  assertCurrent?.();
  return { pluginUpdate, configSnapshot: finalSnapshot };
}
