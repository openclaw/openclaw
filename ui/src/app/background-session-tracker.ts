import type { GatewayBrowserClient } from "../api/gateway.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { uiSessionEventMatches } from "../lib/sessions/session-key.ts";
import type { ApplicationContext } from "./context.ts";
import {
  isCompletionSessionVisible,
  parseSessionCompletionNotice,
  showSessionCompletionNotice,
  type SessionCompletionNotice,
} from "./session-completion-notice.ts";

type TrackingContext = Pick<
  ApplicationContext<"chat">,
  | "gateway"
  | "inAppNotifications"
  | "sessions"
  | "agents"
  | "agentSelection"
  | "basePath"
  | "navigate"
  | "nativeNotifications"
>;

type BackgroundCompletion = {
  current: () => boolean;
  matches: (notice: SessionCompletionNotice) => boolean;
  initialRunId: string;
  yielded: boolean;
  pending?: { notice: SessionCompletionNotice; visible: boolean };
  finish: (notice: SessionCompletionNotice, visibleAtReceipt?: boolean) => void;
};

// Explicit launches are ephemeral browser intent, not an opt-in for every later turn.
// Bound retained starts even if their Gateway never publishes a terminal outcome.
const MAX_BACKGROUND_STARTS = 512;
const trackers = new WeakMap<TrackingContext, Map<string, BackgroundCompletion>>();

export function trackBackgroundSessionCompletion(params: {
  context: TrackingContext;
  client: GatewayBrowserClient;
  agentId: string;
  sessionKey: string;
  runId: string;
}) {
  const { context, client, agentId, sessionKey, runId } = params;
  const { hello, selfUser } = context.gateway.snapshot;
  const revision = context.gateway.connectionRevision;
  const starts = trackers.get(context) ?? new Map<string, BackgroundCompletion>();
  trackers.set(context, starts);
  for (const [key, start] of starts) {
    if (!start.current()) {
      starts.delete(key);
    }
  }
  const key = JSON.stringify([agentId, sessionKey]);
  const current = () => {
    const snapshot = context.gateway.snapshot;
    // Transport retries clear the handshake and profile without replacing the
    // client or credentials. Preserve launch intent during that gap, then
    // require the original account again before accepting a settled outcome.
    const recovering =
      (snapshot.phase === "connecting" ||
        snapshot.phase === "starting" ||
        snapshot.phase === "reconnecting") &&
      snapshot.selfUser === null;
    return (
      starts.get(key) === entry &&
      snapshot.client === client &&
      context.gateway.connectionRevision === revision &&
      (recovering || snapshot.selfUser?.id === selfUser?.id)
    );
  };
  const cancel = () => {
    if (starts.get(key) === entry) {
      starts.delete(key);
    }
  };
  const entry: BackgroundCompletion = {
    current,
    initialRunId: runId,
    yielded: false,
    matches: (notice) =>
      uiSessionEventMatches(
        { hello, assistantAgentId: agentId, sessionKey },
        notice.sessionKey,
        notice.agentId,
      ),
    finish(notice, visibleAtReceipt = false) {
      if (!current() || context.gateway.snapshot.phase !== "connected") {
        cancel();
        return;
      }
      cancel();
      if (!visibleAtReceipt && !isCompletionSessionVisible(context, notice)) {
        const target = sessionNavigationTarget({
          face: "chat",
          sessionKey: notice.sessionKey,
          fallbackAgentId: notice.agentId,
          exactKey: true,
        });
        context.nativeNotifications?.backgroundSessionCompleted({
          runId: notice.runId,
          path: target.options.pathname,
          ...(target.options.search ? { search: target.options.search } : {}),
        });
      }
      showSessionCompletionNotice({
        context,
        client,
        payload: notice,
        backgroundStart: true,
        visibleAtReceipt,
      });
    },
  };
  starts.set(key, entry);
  if (starts.size > MAX_BACKGROUND_STARTS) {
    const oldest = starts.keys().next().value;
    if (oldest !== undefined) {
      starts.delete(oldest);
    }
  }
  return {
    current,
    cancel,
    finish: entry.finish,
    yield() {
      if (!current()) {
        cancel();
        return;
      }
      entry.yielded = true;
      if (entry.pending?.visible) {
        cancel();
      } else if (entry.pending) {
        entry.finish(entry.pending.notice);
      }
    },
  };
}

/** A background start survives child yields even when general completion notices are disabled. */
export function handleSessionCompletionEvent(params: {
  context: TrackingContext;
  client: GatewayBrowserClient;
  payload: unknown;
  visiblePanes?: Parameters<typeof isCompletionSessionVisible>[2];
}): void {
  const { context, client, payload } = params;
  const notice = parseSessionCompletionNotice(payload);
  if (
    !notice ||
    context.gateway.snapshot.client !== client ||
    context.gateway.snapshot.phase !== "connected"
  ) {
    return;
  }
  const visibleAtReceipt = isCompletionSessionVisible(context, notice, params.visiblePanes);
  const starts = trackers.get(context);
  for (const [key, start] of starts ?? []) {
    if (!start.current()) {
      starts?.delete(key);
      continue;
    }
    if (!start.matches(notice)) {
      continue;
    }
    if (start.initialRunId === notice.runId || start.yielded) {
      start.finish(notice, visibleAtReceipt);
      return;
    }
    // The resumed turn may settle before the initial agent.wait response arrives.
    // Retain one candidate, but do not treat an unrelated run as a background
    // completion unless that response establishes the initial turn yielded.
    start.pending ??= {
      notice,
      visible: visibleAtReceipt || isCompletionSessionVisible(context, notice),
    };
  }
  showSessionCompletionNotice({ context, client, payload: notice, visibleAtReceipt });
}
