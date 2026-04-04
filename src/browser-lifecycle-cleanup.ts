import { runBestEffortCleanup } from "./infra/non-fatal-cleanup.js";
import { closeTrackedBrowserTabsForSessions } from "./plugin-sdk/browser-maintenance.js";

function normalizeSessionKeys(sessionKeys: string[]): string[] {
  const keys = new Set<string>();
  for (const sessionKey of sessionKeys) {
    const normalized = sessionKey.trim();
    if (normalized) {
      keys.add(normalized);
    }
  }
  return [...keys];
}

export async function cleanupBrowserSessionsForLifecycleEnd(params: {
  sessionKeys: string[];
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
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
