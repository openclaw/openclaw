import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

/** Select only channel-created Telegram groups with a consistent stored route. */
export function resolveTelegramSessionGroup(
  sessionKey: string,
  entry: Pick<SessionEntry, "createdVia" | "access" | "visibility" | "incognito" | "delivery">,
): { accountId: string; groupId: string } | undefined {
  if (
    entry.createdVia !== "channel" ||
    (entry.access !== undefined && entry.access.mode !== "source") ||
    entry.visibility === "draft" ||
    entry.incognito === true ||
    entry.delivery?.kind !== "external"
  ) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const match = parsed?.rest.match(/^telegram:group:(-[1-9]\d*)(?::topic:(\d+))?$/);
  const { route, origin } = entry.delivery;
  const accountId = normalizeOptionalAccountId(route.accountId);
  if (
    !match ||
    !accountId ||
    route.accountId !== accountId ||
    route.channel !== "telegram" ||
    origin.provider !== "telegram" ||
    origin.chatType !== "group" ||
    (origin.accountId !== undefined && origin.accountId !== accountId)
  ) {
    return undefined;
  }
  const groupId = match[1]!;
  const topic = match[2];
  const target = topic ? `${groupId}:topic:${topic}` : groupId;
  if (
    route.target?.to !== `telegram:${target}` ||
    origin.nativeChannelId !== target ||
    (topic === undefined ? route.thread !== undefined : String(route.thread?.id) !== topic)
  ) {
    return undefined;
  }
  return { accountId, groupId };
}
