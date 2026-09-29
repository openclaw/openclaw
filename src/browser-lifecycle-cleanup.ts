import type { SessionEntryCurrentPreparation } from "./config/sessions/session-entry-current.types.js";
import type { OpenClawConfig } from "./config/types.openclaw.js";
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

function isBrowserCleanupDisabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.browser?.enabled === false || cfg?.plugins?.entries?.browser?.enabled === false;
}

export async function cleanupBrowserSessionsForLifecycleEnd(
  params: SessionEntryCurrentPreparation & {
    cfg?: OpenClawConfig;
    sessionKeys: string[];
    isCurrent?: () => boolean;
    onWarn?: (message: string) => void;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  const { cfg, onError, ...cleanupParams } = params;
  if (isBrowserCleanupDisabled(cfg)) {
    return;
  }
  const sessionKeys = normalizeSessionKeys(params.sessionKeys);
  if (sessionKeys.length === 0) {
    return;
  }
  await runBestEffortCleanup({
    cleanup: async () => {
      await closeTrackedBrowserTabsForSessions({
        ...cleanupParams,
        sessionKeys,
      });
    },
    onError,
  });
}
