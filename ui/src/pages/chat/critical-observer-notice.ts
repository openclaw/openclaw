import type { SessionObserverDigest } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { isCriticalObserverHealth } from "../../lib/observer-digest.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  uiSessionEventMatches,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";

const NOTICE_TRACKER_LIMIT = 256;

export class CriticalObserverNoticeTracker {
  private readonly seen = new Map<string, { health: string; revision: number }>();

  clear(): void {
    this.seen.clear();
  }

  // A reset that replaces the observer lifecycle must retire the prior
  // revision floor for that session, otherwise the new lifecycle's revision 1
  // is rejected as stale against the pre-reset floor. Scoped to one key so
  // other sessions keep their floors.
  forget(params: { sessionKey: string; agentId?: string }): void {
    this.seen.delete(resolveTrackerKey(params.sessionKey, params.agentId));
  }

  record(params: {
    sessionKey: string;
    agentId?: string;
    health: string;
    revision: number;
  }): boolean {
    const key = resolveTrackerKey(params.sessionKey, params.agentId);
    const previous = this.seen.get(key);
    // Gateway revision floors keep revisions session-monotonic across run
    // rollover, so a gap reliably means this connection missed digest state.
    if (previous && params.revision <= previous.revision) {
      return false;
    }
    const shouldAnnounce =
      isCriticalObserverHealth(params.health) &&
      (!previous || previous.health !== params.health || params.revision > previous.revision + 1);
    if (!previous && this.seen.size >= NOTICE_TRACKER_LIMIT) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
    this.seen.delete(key);
    this.seen.set(key, { health: params.health, revision: params.revision });
    return shouldAnnounce;
  }
}

// Shared by record() and forget() so a reset retires the exact key record()
// would consult. Global session keys are namespaced by agentId to match the
// dedup contract in record().
function resolveTrackerKey(sessionKey: string, agentId?: string): string {
  const normalized = normalizeSessionKeyForUiComparison(sessionKey);
  return isUiGlobalSessionKey(normalized) && agentId
    ? `${normalized}:${normalizeAgentId(agentId)}`
    : normalized;
}

export function showCriticalSessionObserverNotice(params: {
  payload: unknown;
  selectedSessionKey: string;
  sessionHost: UiSessionDefaultsHost;
  sessions: readonly GatewaySessionRow[];
  tracker: CriticalObserverNoticeTracker;
  onOpen: (sessionKey: string, agentId?: string) => void;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const digest = params.payload as Partial<SessionObserverDigest>;
  const sessionKey = typeof digest.sessionKey === "string" ? digest.sessionKey.trim() : "";
  const headline = typeof digest.headline === "string" ? digest.headline.trim() : "";
  const revision = digest.revision;
  if (
    !sessionKey ||
    !headline ||
    typeof digest.health !== "string" ||
    revision === undefined ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    return;
  }
  const shouldAnnounce = params.tracker.record({
    sessionKey,
    agentId: digest.agentId,
    health: digest.health,
    revision,
  });
  if (
    !shouldAnnounce ||
    uiSessionEventMatches(
      { ...params.sessionHost, sessionKey: params.selectedSessionKey },
      sessionKey,
      digest.agentId,
    )
  ) {
    return;
  }
  const row = params.sessions.find((session) =>
    areUiSessionKeysEquivalent(session.key, sessionKey),
  );
  const label = resolveSessionDisplayName(sessionKey, row);
  showToast({
    message: `${t("sessionsView.attentionRequired")}: ${label} — ${headline}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () =>
      digest.agentId ? params.onOpen(sessionKey, digest.agentId) : params.onOpen(sessionKey),
  });
}
