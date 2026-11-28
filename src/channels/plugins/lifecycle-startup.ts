/** Invokes optional startup maintenance for loaded channel plugins. */
import { listLoadedChannelPlugins } from "./registry-loaded.js";
import type { ChannelLifecycleAdapter } from "./types.adapters.js";

/** Loaded channel plugins that declare startup maintenance; only these run any. */
export function listChannelPluginStartupMaintenance() {
  return listLoadedChannelPlugins().flatMap((plugin) => {
    const runStartupMaintenance = plugin.lifecycle?.runStartupMaintenance;
    return runStartupMaintenance ? [{ pluginId: plugin.id, runStartupMaintenance }] : [];
  });
}

export async function runChannelPluginStartupMaintenance(
  params: Parameters<NonNullable<ChannelLifecycleAdapter["runStartupMaintenance"]>>[0],
): Promise<void> {
  for (const { pluginId, runStartupMaintenance } of listChannelPluginStartupMaintenance()) {
    try {
      await runStartupMaintenance(params);
    } catch (err) {
      // Startup maintenance is best-effort. One channel failing repair or
      // cleanup must not stop the gateway from starting other channel plugins.
      params.log.warn?.(
        `${params.logPrefix?.trim() || "gateway"}: ${pluginId} startup maintenance failed; continuing: ${String(err)}`,
      );
    }
  }
}
