import { readConfigFileSnapshot } from "../../config/config.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { normalizeUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import {
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_STARTED_AT_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  type PreUpdateConfigRestoreInput,
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
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  readPostCorePluginInstallRecordsFile,
  resolvePostCoreUpdateStartedAtMs,
  writePostCorePluginUpdateResultFile,
  writePostCoreUpdateFailureFile,
} from "./update-command-post-core.js";

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
    assertCurrent,
  });
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
  assertCurrent?: () => void;
}) {
  const { assertCurrent } = params;
  assertCurrent?.();
  const pluginUpdate = await withPluginLifecycleLease({ assertCurrent }, async () => {
    assertCurrent?.();
    // The core migration owner committed before activation. This fresh process
    // reads that generation and only owns plugin convergence.
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
  // Only the target process may restamp an unchanged downgrade config. Plugin
  // migrations that still invalidate it will write through the target Doctor later.
  const finalSnapshot = await readConfigFileSnapshot({ observe: false });
  assertCurrent?.();
  await persistValidatedDowngradeConfig(finalSnapshot, assertCurrent);
  assertCurrent?.();
  return { pluginUpdate, configSnapshot: finalSnapshot };
}
