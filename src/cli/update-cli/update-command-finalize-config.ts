import {
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
  type UpdateChannel,
  UPDATE_EFFECTIVE_CHANNEL_ENV,
} from "../../infra/update-channels.js";
import { POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV } from "../../infra/update-post-core-context.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership-preflight.js";
import type { UpdateFinalizeOptions } from "./shared.js";
import { reportPreMutationUpdateResult } from "./update-command-admission-report.js";
import {
  capturePreUpdateSourceConfig,
  persistRequestedUpdateChannel,
  readPostCorePreUpdateSourceConfig,
  readUpdateConfigFileSnapshot,
} from "./update-command-config.js";
import type { UpdateFinalizationPhase } from "./update-finalization-lifecycle.js";

/** Finalization's source config and channel, read before Doctor can change them. */
export async function prepareUpdateFinalization(
  opts: UpdateFinalizeOptions,
  root: string,
  installKind: "git" | "package" | "unknown",
  requestedChannel: UpdateChannel | null,
  phase: UpdateFinalizationPhase,
) {
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  const configSnapshot = await readUpdateConfigFileSnapshot({
    skipPluginValidation: true,
    observe: false,
  });
  const preFinalizeConfig =
    (await readPostCorePreUpdateSourceConfig({
      sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
      currentSnapshot: configSnapshot,
    })) ?? capturePreUpdateSourceConfig(configSnapshot);
  if (requestedChannel === "extended-stable" && installKind === "git") {
    await reportPreMutationUpdateResult({
      root,
      installKind,
      reason: "unsupported_git_channel",
      opts,
      controlPlaneUpdateSentinelMeta: null,
    });
  }
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  // Effective channel the core update actually ran on (e.g. git/dev for an
  // unconfigured source update), passed by the caller via env. Used only as a
  // convergence fallback; it is never persisted (that stays gated on
  // `requestedChannel`), so a default source update does not write update.channel.
  const effectiveChannel = normalizeUpdateChannel(
    process.env[UPDATE_EFFECTIVE_CHANNEL_ENV]?.trim(),
  );
  const channel = requestedChannel ?? storedChannel ?? effectiveChannel ?? DEFAULT_PACKAGE_CHANNEL;
  if (requestedChannel) {
    await withPluginLifecycleLease(phase, async () => {
      const snapshot = await readUpdateConfigFileSnapshot({
        skipPluginValidation: true,
        observe: false,
      });
      return await persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel,
        assertCurrent: phase.assertCurrent,
      });
    });
  }
  return {
    root,
    installKind,
    preFinalizeConfig,
    requestedChannel,
    channel,
  };
}
