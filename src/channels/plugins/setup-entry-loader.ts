import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "../../plugins/loader-channel-setup.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { preparePluginModule } from "../../plugins/plugin-module-loader-cache.js";
import {
  getPluginSetupModuleLoader,
  preparePluginSetupModuleLoader,
  PluginSetupPreparationRequiredError,
} from "../../plugins/plugin-setup-module.js";
import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";

const log = createSubsystemLogger("channels");

function prepareSetupEntryPath(
  record: PluginManifestRecord,
  source: string,
  env: NodeJS.ProcessEnv,
) {
  return preparePluginModule({
    modulePath: source,
    boundaryRoot: record.rootDir,
    boundaryLabel: "plugin root",
    surfaceLabel: `channel setup entry ${record.id}`,
    rejectHardlinks: shouldRejectHardlinkedPluginFiles({
      origin: record.origin,
      rootDir: record.rootDir,
      env,
    }),
  }).modulePath;
}

/** Prepare only the setup entry selected by read-only channel resolution. */
export async function prepareSetupChannelPluginFromManifestRecord(
  record: PluginManifestRecord,
  env: NodeJS.ProcessEnv,
): Promise<ChannelSetupPluginPreparationFailure | undefined> {
  if (!record.setupSource) {
    return undefined;
  }
  let source: string;
  try {
    source = prepareSetupEntryPath(record, record.setupSource, env);
  } catch (error) {
    return { error };
  }
  await preparePluginSetupModuleLoader(record, source, record.rootDir);
  return undefined;
}

export type ChannelSetupPluginLoadFailure = {
  channelId: string;
  pluginId: string;
  message: string;
  source?: string;
};

export type ChannelSetupPluginPreparationFailure = { error: unknown };

export function loadSetupChannelPluginFromManifestRecord(params: {
  record: PluginManifestRecord;
  channelId: string;
  env: NodeJS.ProcessEnv;
  preparationFailure?: ChannelSetupPluginPreparationFailure;
}): { plugin?: ChannelPlugin; failure?: ChannelSetupPluginLoadFailure } {
  if (!params.record.setupSource || !params.record.channels.includes(params.channelId)) {
    return {};
  }
  try {
    if (params.preparationFailure) {
      throw params.preparationFailure.error;
    }
    const modulePath = prepareSetupEntryPath(params.record, params.record.setupSource, params.env);
    const moduleLoader = getPluginSetupModuleLoader(
      params.record,
      modulePath,
      params.record.rootDir,
    );
    return moduleLoader.initialize(() => {
      const registration = resolveSetupChannelRegistration(moduleLoader(modulePath));
      if ("loadError" in registration) {
        // Preserve the plugin's original failure, including non-Error values.
        throw registration.loadError;
      }
      if (
        !registration.plugin ||
        !channelPluginIdBelongsToManifest({
          channelId: registration.plugin.id,
          pluginId: params.record.id,
          manifestChannels: params.record.channels,
        })
      ) {
        return {};
      }
      return { plugin: registration.plugin };
    });
  } catch (error) {
    if (error instanceof PluginSetupPreparationRequiredError) {
      throw error;
    }
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load channel setup ${params.record.id}: ${detail}`);
    return {
      failure: {
        channelId: params.channelId,
        pluginId: params.record.id,
        source: params.record.setupSource,
        message: `failed to load setup entry: ${detail}`,
      },
    };
  }
}
