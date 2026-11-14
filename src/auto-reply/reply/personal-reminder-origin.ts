import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createCronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import type { PersonalReminderOrigin } from "../../gateway/cron-creator-authority-grant.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import type { resolveEffectiveReplyRoute } from "./effective-reply-route.js";

/** Capture only a linked human on the exact authorized Telegram reply route. */
export function resolvePersonalReminderOrigin(params: {
  eligible: boolean;
  messageProvider?: string;
  operator?: AdmittedRunOperatorAuthority;
  requesterProfileId?: string;
  sessionKey?: string;
  sessionId?: string;
  lifecycleRevision?: string;
  replyRoute: ReturnType<typeof resolveEffectiveReplyRoute>;
  originatingThreadId?: string | number;
}): PersonalReminderOrigin | undefined {
  const { operator, sessionKey, sessionId, replyRoute } = params;
  const agentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  if (
    !params.eligible ||
    params.messageProvider !== "telegram" ||
    replyRoute.channel !== "telegram" ||
    !operator ||
    params.requesterProfileId !== operator.profileId ||
    !operatorScopeSatisfied("operator.cron", operator.scopes) ||
    !agentId ||
    !sessionKey ||
    !sessionId ||
    !replyRoute.to
  ) {
    return undefined;
  }
  const threadId = replyRoute.threadId ?? params.originatingThreadId;
  return {
    profileId: operator.profileId,
    agentId,
    sessionKey,
    sessionId,
    ...(params.lifecycleRevision !== undefined
      ? { lifecycleRevision: params.lifecycleRevision }
      : {}),
    accountId: normalizeAccountId(replyRoute.accountId),
    to: replyRoute.to,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

/** Capture the exact ingress identity for both immediate and later queued admission. */
export function createChannelReminderAuthorityFactory(params: {
  inherited: boolean;
  fresh: boolean;
  messageProvider?: string;
  senderId?: string;
  accountId?: string;
  cronOwner: { channel?: string; accountId?: string; senderId?: string };
  isCurrentChannelOwner: () => boolean;
  personalReminder?: PersonalReminderOrigin;
  operator?: AdmittedRunOperatorAuthority;
}) {
  const { messageProvider, personalReminder, operator } = params;
  if (params.inherited || !params.fresh || !messageProvider) {
    return undefined;
  }
  const channelRequester =
    (messageProvider === "discord" || personalReminder) && params.senderId
      ? {
          version: 1 as const,
          channel: messageProvider,
          accountId: normalizeAccountId(params.accountId),
          senderId: params.senderId,
        }
      : undefined;
  const isCurrentPersonalRequester = () => {
    try {
      operator?.assertCurrent();
      return Boolean(
        operator && personalReminder && operatorScopeSatisfied("operator.cron", operator.scopes),
      );
    } catch {
      return false;
    }
  };
  return (runId: string, isCurrentOwner = params.isCurrentChannelOwner) =>
    createCronCreatorAuthorityCapability(
      runId,
      { kind: "external", channel: messageProvider },
      personalReminder ? undefined : { source: "channel-owner", isCurrent: isCurrentOwner },
      personalReminder ? isCurrentPersonalRequester : undefined,
      channelRequester,
      personalReminder ? undefined : { isCurrent: isCurrentOwner, ...params.cronOwner },
      personalReminder ? true : undefined,
      personalReminder,
    );
}
