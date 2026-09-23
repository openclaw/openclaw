import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerChatProviderReviewEnglish } from "../../i18n/locales/en-chat-provider-review.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  resolveUiSelectedSessionAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { readChatQueueForScope, updateQueuedMessagesForSession } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";

registerChatProviderReviewEnglish();

export type ChatProviderReview = NonNullable<GatewaySessionRow["providerReview"]>;

type ReviewHost = UiSessionDefaultsHost & {
  sessionKey: string;
  sessions?: Partial<SessionCapability>;
  sessionsResult?: SessionsListResult | null;
  sessionsResultAgentId?: string | null;
};

/** Read the shared row owner's latest facts, including a pane's independently observed row. */
export function chatProviderReviewRow(
  host: ReviewHost,
  sessionKey = host.sessionKey,
  agentId = resolveUiSelectedSessionAgentId(host),
): GatewaySessionRow | undefined {
  const matches = (row: GatewaySessionRow, resultAgentId?: string | null) =>
    areUiSessionKeysEquivalent(row.key, sessionKey) &&
    (!isUiGlobalSessionKey(sessionKey) || (row.agentId ?? resultAgentId) === agentId);
  const row =
    host.sessionsResult?.sessions.find((candidate) =>
      matches(candidate, host.sessionsResultAgentId),
    ) ??
    host.sessions?.state?.result?.sessions.find((candidate) =>
      matches(candidate, host.sessions?.state?.agentId),
    );
  return row && (host.sessions?.projectRows?.([row])[0] ?? row);
}

/** The outbox retains delivery identity while provider review revokes passive retry admission. */
export function holdProviderReviewQueuedInputs(
  host: ChatHost,
  sessionKey = host.sessionKey,
  agentId = resolveUiSelectedSessionAgentId(host),
): boolean {
  // "sending" also covers ACKed input awaiting consumption. Holding it keeps the
  // original request alive; only its receipt or an explicit retry can retire the hold.
  const updates = readChatQueueForScope(host, sessionKey, agentId)
    .filter(
      (item) =>
        !item.pendingRunId && item.sendState !== "held" && item.sendState !== "executing-command",
    )
    .map((item) => ({
      id: item.id,
      update: (entry: typeof item) => ({
        ...entry,
        sendState: "held" as const,
        sendError: t("chat.providerReview.queuedInputHeld"),
      }),
    }));
  return updates.length === 0 || updateQueuedMessagesForSession(host, updates);
}
