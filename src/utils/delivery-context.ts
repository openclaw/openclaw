import { normalizeAccountId } from "./account-id.js";

export type DeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export function normalizeDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context) return undefined;
  const channel =
    typeof context.channel === "string" ? context.channel.trim() : undefined;
  const to = typeof context.to === "string" ? context.to.trim() : undefined;
  const accountId = normalizeAccountId(context.accountId);
  if (!channel && !to && !accountId) return undefined;
  return {
    channel: channel || undefined,
    to: to || undefined,
    accountId,
  };
}
