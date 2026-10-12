/** Invokes optional startup maintenance for loaded channel plugins. */
import { listLoadedChannelPlugins } from "./registry-loaded.js";
import type { ChannelLifecycleAdapter } from "./types.adapters.js";

export async function runChannelPluginStartupMaintenance(
  params: Parameters<NonNullable<ChannelLifecycleAdapter["runStartupMaintenance"]>>[0],
): Promise<void> {
  for (const plugin of listLoadedChannelPlugins()) {
    const runStartupMaintenance = plugin.lifecycle?.runStartupMaintenance;
    if (!runStartupMaintenance) {
      continue;
    }
    try {
      await runStartupMaintenance(params);
    } catch (err) {
      // Startup maintenance is best-effort. One channel failing repair or
      // cleanup must not stop the gateway from starting other channel plugins.
      params.log.warn?.(
        `${params.logPrefix?.trim() || "gateway"}: ${plugin.id} startup maintenance failed; continuing: ${String(err)}`,
      );
    }
  }
}
