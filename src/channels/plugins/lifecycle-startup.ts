import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listChannelPlugins } from "./registry.js";
import type { ChannelPlugin } from "./types.plugin.js";

type ChannelStartupLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export async function runChannelPluginStartupMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: ChannelStartupLogger;
  trigger?: string;
  logPrefix?: string;
}): Promise<void> {
  for (const plugin of listChannelPlugins()) {
    const pluginId = channelStartupPluginIdForLog(plugin);
    let runStartupMaintenance:
      | NonNullable<ChannelPlugin["lifecycle"]>["runStartupMaintenance"]
      | undefined;
    try {
      runStartupMaintenance = plugin.lifecycle?.runStartupMaintenance;
    } catch (err) {
      warnChannelStartupMaintenanceFailure(params, pluginId, err);
      continue;
    }
    if (!runStartupMaintenance) {
      continue;
    }
    try {
      await runStartupMaintenance(params);
    } catch (err) {
      warnChannelStartupMaintenanceFailure(params, pluginId, err);
    }
  }
}

function warnChannelStartupMaintenanceFailure(
  params: {
    log: ChannelStartupLogger;
    logPrefix?: string;
  },
  pluginId: string,
  err: unknown,
): void {
  params.log.warn?.(
    `${params.logPrefix?.trim() || "gateway"}: ${pluginId} startup maintenance failed; continuing: ${String(err)}`,
  );
}

function channelStartupPluginIdForLog(plugin: ChannelPlugin): string {
  try {
    const pluginId = plugin.id;
    return typeof pluginId === "string" && pluginId.trim() ? pluginId : "unknown";
  } catch {
    return "unknown";
  }
}
