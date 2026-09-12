/** Returns whether delivery.threadId duplicates a Telegram topic encoded in the target. */
export function cronDeliveryHasRedundantTelegramThreadId(delivery: {
  channel?: unknown;
  to?: unknown;
  threadId?: unknown;
}): boolean {
  const to = typeof delivery.to === "string" ? delivery.to.trim() : "";
  let telegramTarget = to;
  let strippedTelegramPrefix = false;
  while (true) {
    if (/^(?:telegram|tg):/iu.test(telegramTarget)) {
      strippedTelegramPrefix = true;
      telegramTarget = telegramTarget.replace(/^(?:telegram|tg):/iu, "").trim();
      continue;
    }
    if (strippedTelegramPrefix && /^group:/iu.test(telegramTarget)) {
      telegramTarget = telegramTarget.replace(/^group:/iu, "").trim();
      continue;
    }
    break;
  }
  const topicId = /^.+(?::topic:|:)(\d+)$/iu.exec(telegramTarget)?.[1];
  if (
    !topicId ||
    (typeof delivery.threadId !== "string" && typeof delivery.threadId !== "number")
  ) {
    return false;
  }
  const channel = typeof delivery.channel === "string" ? delivery.channel.trim().toLowerCase() : "";
  const isTelegram = channel === "telegram" || strippedTelegramPrefix;
  const threadId = String(delivery.threadId).trim();
  if (!isTelegram || !/^\d+$/u.test(threadId)) {
    return false;
  }
  const canonicalInteger = (value: string) => value.replace(/^0+(?=\d)/u, "");
  return canonicalInteger(threadId) === canonicalInteger(topicId);
}
