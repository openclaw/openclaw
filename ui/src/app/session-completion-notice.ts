import { Value } from "typebox/value";
import {
  SessionRunCompletedEventSchema,
  type SessionRunCompletedEvent as SessionCompletionNotice,
} from "../../../packages/gateway-protocol/src/schema/sessions-run-completed.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { sessionNavigationTarget } from "../lib/sessions/route-navigation.ts";
import { uiSessionEventMatches } from "../lib/sessions/session-key.ts";
import { showToast } from "../lib/toast.ts";
import { selectApplicationSession } from "./agent-selection.ts";
import type { ApplicationContext } from "./context.ts";
import { captureSessionNoticeOwner } from "./session-notice-owner.ts";

export type { SessionRunCompletedEvent as SessionCompletionNotice } from "../../../packages/gateway-protocol/src/schema/sessions-run-completed.ts";

type CompletionContext = Pick<
  ApplicationContext<"chat">,
  | "gateway"
  | "inAppNotifications"
  | "sessions"
  | "agents"
  | "agentSelection"
  | "basePath"
  | "navigate"
>;

const TRACKED_COMPLETIONS = 512;
const notices = new WeakMap<
  GatewayBrowserClient,
  {
    profileId: string | null;
    seen: Map<string, { backgroundStart: boolean; discardedForOptOut: boolean }>;
  }
>();

export function parseSessionCompletionNotice(payload: unknown): SessionCompletionNotice | null {
  if (
    !Value.Check(SessionRunCompletedEventSchema, payload) ||
    !payload.sessionKey.trim() ||
    !payload.agentId.trim() ||
    !payload.runId.trim()
  ) {
    return null;
  }
  return payload;
}

/** Read the existing pane presentation owner, including unfocused split panes. */
export function isCompletionSessionVisible(
  context: CompletionContext,
  notice: SessionCompletionNotice,
  panes: ReadonlyArray<
    Pick<
      HTMLElementTagNameMap["openclaw-chat-pane"],
      "conversationPresented" | "sessionKey" | "agentId"
    >
  > = [...document.querySelectorAll("openclaw-chat-pane")],
): boolean {
  return panes.some(
    (pane) =>
      pane.conversationPresented &&
      uiSessionEventMatches(
        {
          hello: context.gateway.snapshot.hello,
          assistantAgentId: pane.agentId,
          sessionKey: pane.sessionKey,
        },
        notice.sessionKey,
        notice.agentId,
      ),
  );
}

/** Both launch-specific and general completion use one admission/deduplication owner. */
export function showSessionCompletionNotice(params: {
  context: CompletionContext;
  client: GatewayBrowserClient;
  payload: unknown;
  backgroundStart?: boolean;
  visibleAtReceipt?: boolean;
}): void {
  const { context, client } = params;
  const notice = parseSessionCompletionNotice(params.payload);
  const snapshot = context.gateway.snapshot;
  if (
    !notice ||
    snapshot.client !== client ||
    snapshot.phase !== "connected" ||
    (!params.backgroundStart && !context.inAppNotifications?.snapshot.enabled)
  ) {
    return;
  }
  const profileId = snapshot.selfUser?.id ?? null;
  const isCurrentOwner = captureSessionNoticeOwner(context);
  let tracker = notices.get(client);
  if (!tracker || tracker.profileId !== profileId) {
    tracker = { profileId, seen: new Map() };
    notices.set(client, tracker);
  }
  const key = JSON.stringify([notice.agentId, notice.sessionKey, notice.runId]);
  const previous = tracker.seen.get(key);
  if (previous) {
    // A lifecycle event can arrive before the explicit background wait resolves.
    // Preserve that stronger intent when both paths share a queued presentation.
    previous.backgroundStart ||= params.backgroundStart === true;
    if (!params.backgroundStart || !previous.discardedForOptOut) {
      return;
    }
    // Opting out may already have drained and discarded the general notice.
    // Explicit launch intent may restore that unpresented notice, but never one
    // suppressed for visibility or a retired connection/profile.
    tracker.seen.delete(key);
  }
  if (tracker.seen.size >= TRACKED_COMPLETIONS) {
    tracker.seen.delete(tracker.seen.keys().next().value!);
  }
  const entitlement = {
    backgroundStart: params.backgroundStart === true,
    discardedForOptOut: false,
  };
  tracker.seen.set(key, entitlement);
  if (params.visibleAtReceipt || isCompletionSessionVisible(context, notice)) {
    return;
  }
  const row = context.sessions.state.result?.sessions.find((session) =>
    uiSessionEventMatches(
      {
        hello: snapshot.hello,
        assistantAgentId: session.agentId,
        sessionKey: session.key,
      },
      notice.sessionKey,
      notice.agentId,
    ),
  );
  const status =
    notice.status === "ok"
      ? t("sessionsView.statusDone")
      : notice.status === "timeout"
        ? t("sessionsView.statusTimeout")
        : notice.status === "aborted"
          ? t("sessionsView.statusKilled")
          : t("sessionsView.statusFailed");
  showToast({
    fifo: true,
    shouldShow: () => {
      if (!isCurrentOwner() || isCompletionSessionVisible(context, notice)) {
        return false;
      }
      if (!entitlement.backgroundStart && !context.inAppNotifications.snapshot.enabled) {
        entitlement.discardedForOptOut = true;
        return false;
      }
      return true;
    },
    message: `${resolveSessionDisplayName(notice.sessionKey, row)}: ${status}`,
    actionLabel: t("sessionsView.openSession"),
    onAction: () => {
      // A queued toast cannot act on a replacement connection or signed-in profile.
      if (!isCurrentOwner()) {
        return;
      }
      selectApplicationSession({
        selection: context.agentSelection,
        gateway: context.gateway,
        sessionKey: notice.sessionKey,
        agentId: notice.agentId,
      });
      context.navigate(
        "chat",
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey: notice.sessionKey,
          agentId: notice.agentId,
          exactKey: true,
        }).options,
      );
    },
  });
}
