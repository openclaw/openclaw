import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import {
  listCanonicalUserChannelIdentities,
  prepareUserChannelIdentityAuthority,
} from "../state/user-channel-identity-operations.js";

type DirectEntry = Pick<SessionEntry, "createdVia" | "delivery">;
type DirectRoute = { agentId: string; accountId: string; peerId: string; accountInKey: boolean };

/** Only a canonical peer-isolated key and a consistent stored route identify a DM. */
export function resolveTelegramSessionDirect(
  key: string,
  entry: DirectEntry,
): DirectRoute | undefined {
  const match =
    /^agent:([a-z0-9][a-z0-9_-]*):telegram:(?:([a-z0-9][a-z0-9_-]*):)?direct:([1-9]\d*)(?::thread:([1-9]\d*):([1-9]\d*))?$/.exec(
      key,
    );
  if (!match || (entry.createdVia !== undefined && entry.createdVia !== "channel")) {
    return undefined;
  }
  const [, agentId, keyAccount, peerId, threadPeer, threadId] = match;
  const delivery = entry.delivery;
  if (delivery?.kind !== "external") {
    return undefined;
  }
  const { route, origin } = delivery;
  const accountId = normalizeOptionalAccountId(route.accountId);
  if (
    !accountId ||
    route.accountId !== accountId ||
    (keyAccount !== undefined && keyAccount !== accountId) ||
    route.channel !== "telegram" ||
    origin.provider !== "telegram" ||
    origin.chatType !== "direct" ||
    (origin.accountId !== undefined && origin.accountId !== accountId) ||
    (origin.nativeDirectUserId !== undefined && origin.nativeDirectUserId !== peerId) ||
    (origin.threadId !== undefined && String(origin.threadId) !== threadId) ||
    (threadId !== undefined && threadPeer !== peerId)
  ) {
    return undefined;
  }
  const target = route.target?.to;
  if (
    (target !== `telegram:${peerId}` &&
      (threadId === undefined || target !== `telegram:${peerId}:topic:${threadId}`)) ||
    (threadId === undefined ? route.thread !== undefined : String(route.thread?.id) !== threadId) ||
    (origin.nativeChannelId !== undefined &&
      origin.nativeChannelId !== peerId &&
      (threadId === undefined || origin.nativeChannelId !== `${peerId}:topic:${threadId}`))
  ) {
    return undefined;
  }
  return { agentId: agentId!, accountId, peerId: peerId!, accountInKey: keyAccount !== undefined };
}

/** A link proves only route identity; callers must still enforce role, scope and session ACLs. */
export async function prepareTelegramLinkedDirectReads(params: {
  profileId: string;
  signal?: AbortSignal;
  /** Must prove the complete stored conversation is isolated to this account. */
  qualifyAccount?: (key: string, route: DirectRoute) => boolean;
}): Promise<{ canRead: (key: string, entry: DirectEntry) => boolean; revisionKey: () => string }> {
  const facts = new Map<string, { isCurrent: () => boolean }>();
  const signal = params.signal
    ? AbortSignal.any([params.signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000);
  try {
    signal.throwIfAborted();
    const links = await listCanonicalUserChannelIdentities(params.profileId, { signal });
    for (const link of links) {
      signal.throwIfAborted();
      const identity = link.identity;
      if (
        link.profileId !== params.profileId ||
        identity.channelId !== "telegram" ||
        !/^[1-9]\d*$/.test(identity.senderId) ||
        normalizeOptionalAccountId(identity.accountId) !== identity.accountId
      ) {
        continue;
      }
      const authority = await prepareUserChannelIdentityAuthority(identity, { signal });
      signal.throwIfAborted();
      if (authority?.linked.profileId === params.profileId && authority.isCurrent()) {
        facts.set(JSON.stringify([identity.accountId, identity.senderId]), authority);
      }
    }
  } catch {
    // Incomplete preparation cannot disclose a partially resolved identity set.
    facts.clear();
  }
  return {
    revisionKey: () =>
      JSON.stringify([
        Boolean(params.signal?.aborted),
        ...[...facts.values()].map((fact) => fact.isCurrent()),
      ]),
    canRead(key, entry) {
      if (params.signal?.aborted) {
        return false;
      }
      const route = resolveTelegramSessionDirect(key, entry);
      return Boolean(
        route &&
        (route.accountInKey || params.qualifyAccount?.(key, route) === true) &&
        facts.get(JSON.stringify([route.accountId, route.peerId]))?.isCurrent(),
      );
    },
  };
}
