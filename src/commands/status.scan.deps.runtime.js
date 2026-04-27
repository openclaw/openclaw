import { getTailnetHostname } from "../infra/tailscale.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
export { getTailnetHostname };
export async function getMemorySearchManager(params) {
    const { manager } = await getActiveMemorySearchManager(params);
    if (!manager) {
        return { manager: null };
    }
    return {
        manager: {
            async probeVectorAvailability() {
                return await manager.probeVectorAvailability();
            },
            status() {
                return manager.status();
            },
            close: manager.close ? async () => await manager.close?.() : undefined,
        },
    };
}
