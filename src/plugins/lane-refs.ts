import { parseExplicitTargetForChannel } from "../channels/plugins/target-parsing.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import type { PluginActorRef, PluginLaneRef } from "./types.js";

function normalizeLaneChannel(raw: string): string {
  return normalizeMessageChannel(raw) || raw.trim();
}

function parseLaneTarget(params: {
  channel: string;
  rawTarget?: string;
  fallbackThreadId?: string | number;
}): { to: string; threadId?: string | number } | null {
  const normalizedChannel = normalizeMessageChannel(params.channel);
  const rawTarget = params.rawTarget?.trim();
  if (!normalizedChannel || !isDeliverableMessageChannel(normalizedChannel) || !rawTarget) {
    return null;
  }
  return parseExplicitTargetForChannel(normalizedChannel, rawTarget);
}

function parseLaneTargetFallback(params: {
  channel: string;
  rawTarget: string;
}): { to: string; threadId?: string | number } | null {
  if (params.channel !== "telegram") {
    return null;
  }
  const match = /^(-?\d+):topic:([^:]+)$/i.exec(params.rawTarget.trim());
  if (!match) {
    return null;
  }
  return {
    to: match[1],
    threadId: match[2],
  };
}

export function createPluginLaneRef(params: {
  channel: string;
  to?: string;
  accountId?: string | null;
  threadId?: string | number | null;
}): PluginLaneRef | undefined {
  const channel = normalizeLaneChannel(params.channel);
  const rawTarget = params.to?.trim();
  if (!channel || !rawTarget) {
    return undefined;
  }
  const parsed =
    parseLaneTarget({
      channel,
      rawTarget,
      fallbackThreadId: params.threadId ?? undefined,
    }) ?? parseLaneTargetFallback({ channel, rawTarget });
  return {
    channel,
    to: parsed?.to ?? rawTarget,
    ...(params.accountId?.trim() ? { accountId: params.accountId.trim() } : {}),
    ...((params.threadId ?? parsed?.threadId) != null
      ? { threadId: (params.threadId ?? parsed?.threadId)! }
      : {}),
  };
}

export function resolvePluginActorDmLane(actor?: PluginActorRef | null): PluginLaneRef | undefined {
  if (!actor) {
    return undefined;
  }
  if (actor.dmLane) {
    return actor.dmLane;
  }
  const id = actor.id.trim();
  if (!id) {
    return undefined;
  }
  return {
    channel: normalizeLaneChannel(actor.channel),
    to: id,
    ...(actor.accountId?.trim() ? { accountId: actor.accountId.trim() } : {}),
  };
}

export function createPluginActorRef(params: {
  channel: string;
  id?: string;
  accountId?: string | null;
  username?: string;
  displayName?: string;
  dmLane?: PluginLaneRef | null;
}): PluginActorRef | undefined {
  const id = params.id?.trim();
  if (!id) {
    return undefined;
  }
  const actor: PluginActorRef = {
    channel: normalizeLaneChannel(params.channel),
    id,
    ...(params.accountId?.trim() ? { accountId: params.accountId.trim() } : {}),
    ...(params.username?.trim() ? { username: params.username.trim() } : {}),
    ...(params.displayName?.trim() ? { displayName: params.displayName.trim() } : {}),
  };
  const dmLane = params.dmLane ?? resolvePluginActorDmLane(actor);
  if (dmLane) {
    actor.dmLane = dmLane;
  }
  return actor;
}
