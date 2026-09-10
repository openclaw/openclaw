/** Returns whether delivery.threadId duplicates a Telegram topic encoded in the target. */
export function cronDeliveryHasRedundantTelegramThreadId(delivery: {
  channel?: unknown;
  to?: unknown;
  threadId?: unknown;
}): boolean {
  const to = typeof delivery.to === "string" ? delivery.to.trim() : "";
  const topicId = /(?::topic:|:)(\d+)$/iu.exec(to)?.[1];
  if (
    !topicId ||
    (typeof delivery.threadId !== "string" && typeof delivery.threadId !== "number")
  ) {
    return false;
  }
  const channel = typeof delivery.channel === "string" ? delivery.channel.trim().toLowerCase() : "";
  const isTelegram = channel === "telegram" || /^telegram:/iu.test(to);
  const threadId = String(delivery.threadId).trim();
  if (!isTelegram || !/^\d+$/u.test(threadId)) {
    return false;
  }
  const canonicalInteger = (value: string) => value.replace(/^0+(?=\d)/u, "");
  return canonicalInteger(threadId) === canonicalInteger(topicId);
}
