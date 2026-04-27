import { runBestEffortCleanup } from "./infra/non-fatal-cleanup.js";
import { closeTrackedBrowserTabsForSessions } from "./plugin-sdk/browser-maintenance.js";
function normalizeSessionKeys(sessionKeys) {
    const keys = new Set();
    for (const sessionKey of sessionKeys) {
        const normalized = sessionKey.trim();
        if (normalized) {
            keys.add(normalized);
        }
    }
    return [...keys];
}
export async function cleanupBrowserSessionsForLifecycleEnd(params) {
    const sessionKeys = normalizeSessionKeys(params.sessionKeys);
    if (sessionKeys.length === 0) {
        return;
    }
    await runBestEffortCleanup({
        cleanup: async () => {
            await closeTrackedBrowserTabsForSessions({
                sessionKeys,
                onWarn: params.onWarn,
            });
        },
        onError: params.onError,
    });
}
