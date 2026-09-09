/** Returns whether a Telegram topic is already encoded in the delivery target. */
export function cronDeliveryTargetIncludesTelegramTopic(delivery: {
  channel?: unknown;
  to?: unknown;
}): boolean {
  const to = typeof delivery.to === "string" ? delivery.to.trim() : "";
  if (!/:topic:[^:]+$/iu.test(to)) {
    return false;
  }
  const channel = typeof delivery.channel === "string" ? delivery.channel.trim().toLowerCase() : "";
  return channel === "telegram" || /^telegram:/iu.test(to);
}
