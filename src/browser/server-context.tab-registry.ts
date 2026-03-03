import type { ProfileRuntimeState, TabMeta } from "./server-context.types.js";

/** Default idle timeout: 30 minutes.  Tabs untouched for longer are eligible for cleanup. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Interval between idle-tab sweeps. */
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function ensureRegistry(profileState: ProfileRuntimeState): Map<string, TabMeta> {
  if (!profileState.tabRegistry) {
    profileState.tabRegistry = new Map();
  }
  return profileState.tabRegistry;
}

export function registerTab(
  profileState: ProfileRuntimeState,
  targetId: string,
  url: string,
  ownerId?: string,
): TabMeta {
  const registry = ensureRegistry(profileState);
  const now = Date.now();
  const meta: TabMeta = {
    targetId,
    url,
    openedAt: now,
    lastAccessedAt: now,
    ownerId: ownerId || undefined,
    lastAccessedBy: ownerId || undefined,
  };
  registry.set(targetId, meta);
  return meta;
}

export function unregisterTab(profileState: ProfileRuntimeState, targetId: string): boolean {
  return ensureRegistry(profileState).delete(targetId);
}

export function touchTab(
  profileState: ProfileRuntimeState,
  targetId: string,
  accessedBy?: string,
): void {
  const meta = ensureRegistry(profileState).get(targetId);
  if (meta) {
    meta.lastAccessedAt = Date.now();
    if (accessedBy) {
      meta.lastAccessedBy = accessedBy;
    }
  }
}

export function getTabRegistry(profileState: ProfileRuntimeState): Map<string, TabMeta> {
  return ensureRegistry(profileState);
}

export function getTabsByOwner(profileState: ProfileRuntimeState, ownerId: string): TabMeta[] {
  const registry = ensureRegistry(profileState);
  return [...registry.values()].filter((m) => m.ownerId === ownerId);
}

// ---------------------------------------------------------------------------
// Idle tab sweep
// ---------------------------------------------------------------------------

const sweepTimers = new WeakMap<ProfileRuntimeState, ReturnType<typeof setInterval>>();

/**
 * Start the idle-tab sweep timer for a profile.  Re-entrant — calling
 * multiple times for the same profile is a no-op.
 *
 * @param closeTab  callback that actually closes a tab by targetId
 */
export function startIdleTabSweep(
  profileState: ProfileRuntimeState,
  closeTab: (targetId: string) => Promise<void>,
  idleTimeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): void {
  if (sweepTimers.has(profileState)) {
    return;
  }

  const timer = setInterval(() => {
    const now = Date.now();
    const registry = ensureRegistry(profileState);
    for (const [targetId, meta] of registry) {
      if (now - meta.lastAccessedAt > idleTimeoutMs) {
        void closeTab(targetId).catch(() => {
          // best-effort — the tab may already be gone
        });
        registry.delete(targetId);
      }
    }
  }, IDLE_SWEEP_INTERVAL_MS);

  // Ensure the timer does not prevent Node from exiting.
  if (typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }

  sweepTimers.set(profileState, timer);
}

export function stopIdleTabSweep(profileState: ProfileRuntimeState): void {
  const timer = sweepTimers.get(profileState);
  if (timer) {
    clearInterval(timer);
    sweepTimers.delete(profileState);
  }
}
