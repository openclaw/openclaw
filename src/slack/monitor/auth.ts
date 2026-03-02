import { readStoreAllowFromForDmPolicy } from "../../security/dm-policy-shared.js";
import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
  resolveSlackUserAllowed,
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "./context.js";

type ResolvedAllowFromLists = {
  allowFrom: string[];
  allowFromLower: string[];
};

type SlackAllowFromCacheState = {
  baseSignature?: string;
  base?: ResolvedAllowFromLists;
  pairingKey?: string;
  pairing?: ResolvedAllowFromLists;
  pairingExpiresAtMs?: number;
  pairingPending?: Promise<ResolvedAllowFromLists>;
};

let slackAllowFromCache = new WeakMap<SlackMonitorContext, SlackAllowFromCacheState>();
const DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS = 5000;

function getPairingAllowFromCacheTtlMs(): number {
  const raw = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
  }
  return Math.max(0, Math.floor(parsed));
}

function getAllowFromCacheState(ctx: SlackMonitorContext): SlackAllowFromCacheState {
  const existing = slackAllowFromCache.get(ctx);
  if (existing) {
    return existing;
  }
  const next: SlackAllowFromCacheState = {};
  slackAllowFromCache.set(ctx, next);
  return next;
}

function buildBaseAllowFrom(ctx: SlackMonitorContext): ResolvedAllowFromLists {
  const allowFrom = normalizeAllowList(ctx.allowFrom);
  return {
    allowFrom,
    allowFromLower: normalizeAllowListLower(allowFrom),
  };
}

export async function resolveSlackEffectiveAllowFrom(
  ctx: SlackMonitorContext,
  options?: { includePairingStore?: boolean },
) {
  const includePairingStore = options?.includePairingStore === true;
  const cache = getAllowFromCacheState(ctx);
  const baseSignature = JSON.stringify(ctx.allowFrom);
  if (cache.baseSignature !== baseSignature || !cache.base) {
    cache.baseSignature = baseSignature;
    cache.base = buildBaseAllowFrom(ctx);
    cache.pairing = undefined;
    cache.pairingKey = undefined;
    cache.pairingExpiresAtMs = undefined;
    cache.pairingPending = undefined;
  }
  if (!includePairingStore) {
    return cache.base;
  }

  const ttlMs = getPairingAllowFromCacheTtlMs();
  const nowMs = Date.now();
  const pairingKey = `${ctx.accountId}:${ctx.dmPolicy}`;
  if (
    ttlMs > 0 &&
    cache.pairing &&
    cache.pairingKey === pairingKey &&
    (cache.pairingExpiresAtMs ?? 0) >= nowMs
  ) {
    return cache.pairing;
  }
  if (cache.pairingPending && cache.pairingKey === pairingKey) {
    return await cache.pairingPending;
  }

  const pairingPending = (async (): Promise<ResolvedAllowFromLists> => {
    let storeAllowFrom: string[] = [];
    try {
      const resolved = await readStoreAllowFromForDmPolicy({
        provider: "slack",
        accountId: ctx.accountId,
        dmPolicy: ctx.dmPolicy,
      });
      storeAllowFrom = Array.isArray(resolved) ? resolved : [];
    } catch {
      storeAllowFrom = [];
    }
    const allowFrom = normalizeAllowList([...(cache.base?.allowFrom ?? []), ...storeAllowFrom]);
    return {
      allowFrom,
      allowFromLower: normalizeAllowListLower(allowFrom),
    };
  })();

  cache.pairingKey = pairingKey;
  cache.pairingPending = pairingPending;
  try {
    const resolved = await pairingPending;
    if (ttlMs > 0) {
      cache.pairing = resolved;
      cache.pairingExpiresAtMs = nowMs + ttlMs;
    } else {
      cache.pairing = undefined;
      cache.pairingExpiresAtMs = undefined;
    }
    return resolved;
  } finally {
    if (cache.pairingPending === pairingPending) {
      cache.pairingPending = undefined;
    }
  }
}

export function clearSlackAllowFromCacheForTest(): void {
  slackAllowFromCache = new WeakMap<SlackMonitorContext, SlackAllowFromCacheState>();
}

export function isSlackSenderAllowListed(params: {
  allowListLower: string[];
  senderId: string;
  senderName?: string;
  allowNameMatching?: boolean;
}) {
  const { allowListLower, senderId, senderName, allowNameMatching } = params;
  return (
    allowListLower.length === 0 ||
    allowListMatches({
      allowList: allowListLower,
      id: senderId,
      name: senderName,
      allowNameMatching,
    })
  );
}

export type SlackSystemEventAuthResult = {
  allowed: boolean;
  reason?:
    | "missing-sender"
    | "sender-mismatch"
    | "channel-not-allowed"
    | "dm-disabled"
    | "sender-not-allowlisted"
    | "sender-not-channel-allowed";
  channelType?: "im" | "mpim" | "channel" | "group";
  channelName?: string;
};

export async function authorizeSlackSystemEventSender(params: {
  ctx: SlackMonitorContext;
  senderId?: string;
  channelId?: string;
  channelType?: string | null;
  expectedSenderId?: string;
}): Promise<SlackSystemEventAuthResult> {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return { allowed: false, reason: "missing-sender" };
  }

  const expectedSenderId = params.expectedSenderId?.trim();
  if (expectedSenderId && expectedSenderId !== senderId) {
    return { allowed: false, reason: "sender-mismatch" };
  }

  const channelId = params.channelId?.trim();
  let channelType = normalizeSlackChannelType(params.channelType, channelId);
  let channelName: string | undefined;
  if (channelId) {
    const info: {
      name?: string;
      type?: "im" | "mpim" | "channel" | "group";
    } = await params.ctx.resolveChannelName(channelId).catch(() => ({}));
    channelName = info.name;
    channelType = normalizeSlackChannelType(params.channelType ?? info.type, channelId);
    if (
      !params.ctx.isChannelAllowed({
        channelId,
        channelName,
        channelType,
      })
    ) {
      return {
        allowed: false,
        reason: "channel-not-allowed",
        channelType,
        channelName,
      };
    }
  }

  const senderInfo: { name?: string } = await params.ctx
    .resolveUserName(senderId)
    .catch(() => ({}));
  const senderName = senderInfo.name;

  const resolveAllowFromLower = async (includePairingStore = false) =>
    (await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore })).allowFromLower;

  if (channelType === "im") {
    if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
      return { allowed: false, reason: "dm-disabled", channelType, channelName };
    }
    if (params.ctx.dmPolicy !== "open") {
      const allowFromLower = await resolveAllowFromLower(true);
      const senderAllowListed = isSlackSenderAllowListed({
        allowListLower: allowFromLower,
        senderId,
        senderName,
        allowNameMatching: params.ctx.allowNameMatching,
      });
      if (!senderAllowListed) {
        return {
          allowed: false,
          reason: "sender-not-allowlisted",
          channelType,
          channelName,
        };
      }
    }
  } else if (!channelId) {
    // No channel context. Apply allowFrom if configured so we fail closed
    // for privileged interactive events when owner allowlist is present.
    const allowFromLower = await resolveAllowFromLower(false);
    if (allowFromLower.length > 0) {
      const senderAllowListed = isSlackSenderAllowListed({
        allowListLower: allowFromLower,
        senderId,
        senderName,
        allowNameMatching: params.ctx.allowNameMatching,
      });
      if (!senderAllowListed) {
        return { allowed: false, reason: "sender-not-allowlisted" };
      }
    }
  } else {
    const channelConfig = resolveSlackChannelConfig({
      channelId,
      channelName,
      channels: params.ctx.channelsConfig,
      defaultRequireMention: params.ctx.defaultRequireMention,
    });
    const channelUsersAllowlistConfigured =
      Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
    if (channelUsersAllowlistConfigured) {
      const channelUserAllowed = resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: senderId,
        userName: senderName,
        allowNameMatching: params.ctx.allowNameMatching,
      });
      if (!channelUserAllowed) {
        return {
          allowed: false,
          reason: "sender-not-channel-allowed",
          channelType,
          channelName,
        };
      }
    }
  }

  return {
    allowed: true,
    channelType,
    channelName,
  };
}
