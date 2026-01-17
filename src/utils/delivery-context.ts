import { normalizeAccountId } from "./account-id.js";

export type DeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) return undefined;
  const channel = typeof context.channel === "string" ? context.channel.trim() : undefined;
  const to = typeof context.to === "string" ? context.to.trim() : undefined;
  const accountId = normalizeAccountId(context.accountId);
  if (!channel && !to && !accountId) return undefined;
  return {
    channel: channel || undefined,
    to: to || undefined,
    accountId,
  };
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
