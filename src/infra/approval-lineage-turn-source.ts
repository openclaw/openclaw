// Routes approvals raised in agent-driven child sessions to the chat that spawned them.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { loadApprovalSessionEntry } from "./approval-request-account-binding.js";

const MAX_LINEAGE_HOPS = 8;

export type ApprovalLineageTurnSource = {
  turnSourceChannel: string;
  turnSourceTo: string;
  turnSourceAccountId: string | null;
  turnSourceThreadId: string | number | null;
};

/**
 * Borrows the nearest spawning ancestor's external chat for a session that has
 * none, unless a live external turn or a reviewing device already owns it.
 */
export function resolveApprovalLineageTurnSource(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
  agentId?: string | null;
  turnSourceChannel?: string | null;
  reviewerDeviceIds?: readonly string[] | null;
}): ApprovalLineageTurnSource | null {
  if (params.reviewerDeviceIds?.some((id) => normalizeOptionalString(id))) {
    return null;
  }
  const turnSourceChannel = normalizeMessageChannel(params.turnSourceChannel);
  if (turnSourceChannel && turnSourceChannel !== INTERNAL_MESSAGE_CHANNEL) {
    return null;
  }
  const origin = loadApprovalSessionEntry({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (!origin || origin.entry.delivery?.kind === "external") {
    return null;
  }
  const visited = new Set([origin.sessionKey]);
  let entry = origin.entry;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    // parentSessionKey alone also links Control UI threads; only a spawn hands work down.
    const nextKey = normalizeOptionalString(entry.completionOwnerSessionKey ?? entry.spawnedBy);
    if (!nextKey || visited.has(nextKey)) {
      return null;
    }
    visited.add(nextKey);
    const ancestor = loadApprovalSessionEntry({ cfg: params.cfg, sessionKey: nextKey });
    if (!ancestor) {
      return null;
    }
    const context = deliveryContextFromSession(ancestor.entry);
    const channel = normalizeMessageChannel(context?.channel);
    const to = normalizeOptionalString(context?.to);
    if (channel && to && isDeliverableMessageChannel(channel)) {
      return {
        turnSourceChannel: channel,
        turnSourceTo: to,
        turnSourceAccountId: normalizeOptionalString(context?.accountId) ?? null,
        turnSourceThreadId: context?.threadId ?? null,
      };
    }
    entry = ancestor.entry;
  }
  return null;
}
