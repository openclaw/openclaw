import { listChannelPlugins } from "./registry.js";
export async function runChannelPluginStartupMaintenance(params) {
    for (const plugin of listChannelPlugins()) {
        const runStartupMaintenance = plugin.lifecycle?.runStartupMaintenance;
        if (!runStartupMaintenance) {
            continue;
        }
        try {
            await runStartupMaintenance(params);
        }
        catch (err) {
            params.log.warn?.(`${params.logPrefix?.trim() || "gateway"}: ${plugin.id} startup maintenance failed; continuing: ${String(err)}`);
        }
    }
}
