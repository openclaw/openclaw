import { normalizeAccountId } from "./account-id.js";
import { normalizeMessageChannel } from "./message-channel.js";

export type DeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type DeliveryContextSessionSource = {
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  deliveryContext?: DeliveryContext;
};

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) return undefined;
  const channel =
    typeof context.channel === "string"
      ? (normalizeMessageChannel(context.channel) ?? context.channel.trim())
      : undefined;
  const to = typeof context.to === "string" ? context.to.trim() : undefined;
  const accountId = normalizeAccountId(context.accountId);
  if (!channel && !to && !accountId) return undefined;
  return {
    channel: channel || undefined,
    to: to || undefined,
    accountId,
  };
}

export function normalizeSessionDeliveryFields(source?: DeliveryContextSessionSource): {
  deliveryContext?: DeliveryContext;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
} {
  if (!source) {
    return {
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
    };
  }

  const merged = mergeDeliveryContext(
    normalizeDeliveryContext({
      channel: source.lastChannel ?? source.channel,
      to: source.lastTo,
      accountId: source.lastAccountId,
    }),
    normalizeDeliveryContext(source.deliveryContext),
  );

  if (!merged) {
    return {
      deliveryContext: undefined,
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
    };
  }

  return {
    deliveryContext: merged,
    lastChannel: merged.channel,
    lastTo: merged.to,
    lastAccountId: merged.accountId,
  };
}

export function deliveryContextFromSession(
  entry?: DeliveryContextSessionSource,
): DeliveryContext | undefined {
  if (!entry) return undefined;
  return normalizeSessionDeliveryFields(entry).deliveryContext;
}

export function mergeDeliveryContext(
  primary?: DeliveryContext,
  fallback?: DeliveryContext,
): DeliveryContext | undefined {
  const normalizedPrimary = normalizeDeliveryContext(primary);
  const normalizedFallback = normalizeDeliveryContext(fallback);
  if (!normalizedPrimary && !normalizedFallback) return undefined;
  return normalizeDeliveryContext({
    channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
    to: normalizedPrimary?.to ?? normalizedFallback?.to,
    accountId: normalizedPrimary?.accountId ?? normalizedFallback?.accountId,
  });
}

export function deliveryContextKey(context?: DeliveryContext): string | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel || !normalized?.to) return undefined;
  return `${normalized.channel}|${normalized.to}|${normalized.accountId ?? ""}`;
}
