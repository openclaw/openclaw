import { DEFAULT_AGENT_ID, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { normalizeSessionRowKey } from "./store-entry.js";
import { getSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

type ExtractedDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

export type ParsedSessionThreadInfo = {
  baseSessionKey: string | undefined;
  threadId: string | undefined;
};

function hasRoutableDeliveryContext(context: DeliveryContext | undefined): boolean {
  return Boolean(context?.channel && context?.to);
}

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toExtractedDeliveryContext(
  entry: SessionEntry | undefined,
): ExtractedDeliveryContext | undefined {
  const context = deliveryContextFromSession(entry);
  if (!hasRoutableDeliveryContext(context)) {
    return undefined;
  }
  return {
    channel: context?.channel,
    to: context?.to,
    accountId: context?.accountId,
    threadId: normalizeThreadId(context?.threadId),
  };
}

function resolveAgentId(sessionKey: string): string {
  return resolveAgentIdFromSessionKey(sessionKey) ?? DEFAULT_AGENT_ID;
}

function readDeliverySessionEntry(sessionKey: string): SessionEntry | undefined {
  const agentId = resolveAgentId(sessionKey);
  return getSessionEntry({
    agentId,
    sessionKey: normalizeSessionRowKey(sessionKey),
  });
}

export function parseSessionThreadInfo(sessionKey: string | undefined): ParsedSessionThreadInfo {
  return {
    baseSessionKey: sessionKey,
    threadId: undefined,
  };
}

export function extractDeliveryInfo(sessionKey: string | undefined): {
  deliveryContext: ExtractedDeliveryContext | undefined;
  threadId: string | undefined;
} {
  if (!sessionKey) {
    return { deliveryContext: undefined, threadId: undefined };
  }

  try {
    const entry = readDeliverySessionEntry(sessionKey);
    const deliveryContext = toExtractedDeliveryContext(entry);
    return {
      deliveryContext,
      threadId: deliveryContext?.threadId,
    };
  } catch {
    return { deliveryContext: undefined, threadId: undefined };
  }
}
