import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "../../plugins/loader-channel-setup.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { preparePluginModule } from "../../plugins/plugin-module-loader-cache.js";
import { getPluginSetupModuleLoader } from "../../plugins/plugin-setup-module.js";
import type { ChannelPlugin } from "./types.plugin.js";

const log = createSubsystemLogger("channels");

export type ChannelSetupPluginLoadFailure = {
  channelId: string;
  pluginId: string;
  message: string;
  source?: string;
};

export function loadSetupChannelPluginFromManifestRecord(params: {
  record: PluginManifestRecord;
  channelId: string;
  env: NodeJS.ProcessEnv;
}): { plugin?: ChannelPlugin; failure?: ChannelSetupPluginLoadFailure } {
  if (!params.record.setupSource || !params.record.channels.includes(params.channelId)) {
    return {};
  }
  try {
    const { modulePath } = preparePluginModule({
      modulePath: params.record.setupSource,
      boundaryRoot: params.record.rootDir,
      boundaryLabel: "plugin root",
      surfaceLabel: `channel setup entry ${params.record.id}`,
      rejectHardlinks: shouldRejectHardlinkedPluginFiles({
        origin: params.record.origin,
        rootDir: params.record.rootDir,
        env: params.env,
      }),
    });
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
