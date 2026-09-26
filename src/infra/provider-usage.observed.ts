import type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "./provider-usage.types.js";

// Quota windows a CLI runtime reported while running a turn, for the login
// that runtime owns and OpenClaw never uses for usage requests.
// Claude Code owns its login, so the gateway only sees the subscription
// windows through the `rate_limit_event` it streams on every turn. The store is
// process-local and derived: a newer observation of a window replaces the older one,
// and a window stops being served once its reset time has passed. A window
// without a reset time, or with one beyond the longest quota period, could never
// expire in practice, so it is not recorded.
type ObservedWindow = { window: UsageWindow; observedAt: number };

const observedWindows = new Map<UsageProviderId, ObservedWindow[]>();
let observedWindowSetVersion = 0;

// The longest subscription window is a week; allow a day of clock slack.
const MAX_OBSERVED_RESET_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

/** Usage row for the subscription behind Claude Code's own login. */
export const CLAUDE_CODE_USAGE_PROVIDER: UsageProviderId = "claude-cli";
const CLAUDE_CODE_USAGE_DISPLAY_NAME = "Claude Code";

/** Windows a runtime reported, and when the oldest of them was reported. */
type ObservedProviderUsage = { windows: UsageWindow[]; observedAt: number };

/** Records the latest runtime-observed quota windows for a usage provider. */
export function recordObservedProviderUsageWindows(
  provider: UsageProviderId,
  windows: UsageWindow[],
  observedAt: number = Date.now(),
): void {
  const expiring = windows.filter(
    (window) =>
      window.resetAt !== undefined && window.resetAt <= observedAt + MAX_OBSERVED_RESET_HORIZON_MS,
  );
  if (expiring.length === 0) {
    return;
  }
  // A record can carry a subset of windows; keep the others until they reset.
  const labels = new Set(expiring.map((window) => window.label));
  const previous = observedWindows.get(provider) ?? [];
  const current = new Set(
    previous
      .filter((entry) => (entry.window.resetAt ?? 0) > observedAt)
      .map((entry) => entry.window.label),
  );
  if (expiring.some((window) => !current.has(window.label))) {
    observedWindowSetVersion += 1;
  }
  const kept = previous.filter((entry) => !labels.has(entry.window.label));
  observedWindows.set(provider, [...kept, ...expiring.map((window) => ({ window, observedAt }))]);
}

/**
 * Changes when a provider gains an observed window it did not have, such as the
 * first turn after a Gateway start or the first turn after a window reset.
 * Usage caches compare it so a new row appears without waiting for their TTL;
 * newer readings of windows already shown follow the normal refresh cadence.
 */
export function observedProviderUsageWindowSetVersion(): number {
  return observedWindowSetVersion;
}

/** Returns observed windows that have not reached their reset time. */
function readObservedProviderUsage(
  provider: UsageProviderId,
  now: number,
): ObservedProviderUsage | undefined {
  const entries = observedWindows.get(provider);
  if (!entries) {
    return undefined;
  }
  const current = entries.filter((entry) => (entry.window.resetAt ?? 0) > now);
  if (current.length === 0) {
    observedWindows.delete(provider);
    return undefined;
  }
  // Report the oldest observation so a stale window is never presented as fresh.
  return {
    windows: current.map((entry) => entry.window),
    observedAt: Math.min(...current.map((entry) => entry.observedAt)),
  };
}

/** The Claude Code usage row, or nothing when no current window was observed. */
export function readClaudeCodeUsageSnapshot(now: number): ProviderUsageSnapshot | undefined {
  const usage = readObservedProviderUsage(CLAUDE_CODE_USAGE_PROVIDER, now);
  return usage
    ? {
        provider: CLAUDE_CODE_USAGE_PROVIDER,
        displayName: CLAUDE_CODE_USAGE_DISPLAY_NAME,
        windows: usage.windows,
        observedAt: usage.observedAt,
      }
    : undefined;
}

// Whether each session's latest Claude Code turn ran on the Gateway host's own
// login, as the runner judged it from the turn's real environment, arguments,
// and account. /status can see the session's auth profile but not its backend
// environment, so it shows the host login's windows only to admitted sessions.
const claudeCodeHostLoginBySession = new Map<string, boolean>();
const MAX_NOTED_CLAUDE_CODE_SESSIONS = 4096;

/** Notes whether a session's Claude Code turn ran on the Gateway host's own login. */
export function noteClaudeCodeSessionRoute(sessionKey: string, onHostLogin: boolean): void {
  claudeCodeHostLoginBySession.delete(sessionKey);
  claudeCodeHostLoginBySession.set(sessionKey, onHostLogin);
  if (claudeCodeHostLoginBySession.size > MAX_NOTED_CLAUDE_CODE_SESSIONS) {
    const oldest = claudeCodeHostLoginBySession.keys().next().value;
    if (oldest !== undefined) {
      claudeCodeHostLoginBySession.delete(oldest);
    }
  }
}

/** Whether the session's latest Claude Code turn since the last clear ran on the host login. */
export function claudeCodeSessionRanOnHostLogin(sessionKey: string): boolean {
  return claudeCodeHostLoginBySession.get(sessionKey) === true;
}

/** Drops every observation; the next CLI turn records fresh windows. */
export function clearObservedProviderUsageWindows(): void {
  observedWindows.clear();
  claudeCodeHostLoginBySession.clear();
}
