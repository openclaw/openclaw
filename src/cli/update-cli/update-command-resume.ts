import { readConfigFileSnapshot } from "../../config/config.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { hasDeferredUpdateModelRetirement } from "../../infra/update-deferred-model-retirement.js";
import {
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
} from "../../infra/update-post-core-context.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "../../plugins/installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
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
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  postCoreUpdateParentOwnsCompletion,
  readPostCorePluginInstallRecordsFile,
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
    await resumePostCoreUpdateInternal(params);
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

  const parentOwnsCompletion = await postCoreUpdateParentOwnsCompletion(
    process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
  );
  await withPluginLifecycleLease({}, async (lease) => {
    await completeSourceUpdateRuntime({ root: params.root, timeoutMs: params.timeoutMs, lease });
  });
  if (!parentOwnsCompletion) {
    // Shipped parents expect the child to prepare migration plugins and settle
    // Doctor before plugin config writes; Doctor owns that preparation and its guards.
    await runUpdateFinalizationDoctorInFreshProcess({
      phase: "post-plugin",
      root: params.root,
      yes: params.opts.yes === true,
      json: params.opts.json === true,
      timeoutMs: params.timeoutMs,
    });
  }

  const configSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: true,
    suppressFutureVersionWarning: true,
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
  const producedPluginUpdate = await withPluginLifecycleLease({}, async () => {
    const preparedConfig = await preparePostCorePluginConfig({
      requestedChannel,
      preUpdateConfig: preUpdateSourceConfig,
      suppressFutureVersionWarning: true,
    });
    // The updated doctor may have repaired or removed plugin installs before this process resumed.
    const currentPluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    const persistedPluginIndex = await readPersistedInstalledPluginIndex();
    const hasForwardedUpdateStart = Boolean(process.env[POST_CORE_UPDATE_STARTED_AT_ENV]?.trim());
    const currentIndexIsAuthoritative =
      Object.keys(currentPluginInstallRecords).length > 0 ||
      Boolean(
        persistedPluginIndex &&
        hasForwardedUpdateStart &&
        updateStartedAtMs !== undefined &&
        persistedPluginIndex.generatedAtMs >= updateStartedAtMs,
      );
    const pluginInstallRecords = currentIndexIsAuthoritative
      ? currentPluginInstallRecords
      : parentPluginInstallRecords;

    return await updatePluginsAfterCoreUpdate({
      root: params.root,
      channel,
      ...preparedConfig,
      json: params.opts.json,
      acceptCapabilities: params.opts.acceptCapabilities,
      timeoutMs: params.timeoutMs,
      pluginInstallRecords,
    });
  });
  // Release plugin ownership before Doctor reacquires it. Publishing the result
  // permits the parent to stop this child, so all child-owned work must settle first.
  const pluginUpdate =
    !parentOwnsCompletion || (!producedPluginUpdate.changed && hasDeferredUpdateModelRetirement())
      ? (
          await completePostCorePluginUpdate({
            root: params.root,
            pluginUpdate: producedPluginUpdate,
            freshDoctorRequired: producedPluginUpdate.changed,
            yes: params.opts.yes === true,
            json: params.opts.json === true,
            timeoutMs: params.timeoutMs,
          })
        ).pluginUpdate
      : producedPluginUpdate;
  // Only the target process may restamp an unchanged downgrade config. Plugin
  // migrations that still invalidate it will write through the target Doctor later.
  await persistValidatedDowngradeConfig(await readConfigFileSnapshot());
  if (process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
    await writePostCorePluginUpdateResultFile(
      process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
      pluginUpdate,
    );
  }
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
