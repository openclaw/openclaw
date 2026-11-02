import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionCatalogTranscriptItem } from "../../../../packages/gateway-protocol/src/index.js";
import { projectCatalogItemForDisplay } from "../../../../src/chat/session-catalog-display.js";
import { t } from "../../i18n/index.ts";
import { catalogMessageId } from "./catalog-message-id.ts";

export function catalogItemMessage(
  item: SessionCatalogTranscriptItem,
): Record<string, unknown> | null {
  const timestamp = parseDateStringTimestampMs(item.timestamp);
  const message = projectCatalogItemForDisplay(item);
  if (!message) {
    return null;
  }
  return {
    ...message,
    ...(timestamp == null ? {} : { timestamp }),
    ...(item.type === "userMessage"
      ? {
          senderLabel: item.sender?.label ?? t("sessionsView.user"),
          ...(item.sender
            ? {
                __openclaw: {
                  ...asOptionalRecord(message["__openclaw"]),
                  senderIdentity: item.sender.identity,
                  senderId: item.sender.identity.id,
                  senderName: item.sender.label,
                  senderProfileAvatarUrl: item.sender.avatarUrl,
                },
              }
            : {}),
        }
      : {}),
  };
}

export function prependUniqueCatalogMessages(
  messages: unknown[],
  previous: readonly unknown[],
): unknown[] {
  const seenIds = new Set(previous.map(catalogMessageId).filter(Boolean));
  const uniqueMessages = messages.filter((message) => {
    const messageId = catalogMessageId(message);
    if (!messageId || !seenIds.has(messageId)) {
      if (messageId) {
        seenIds.add(messageId);
      }
      return true;
    }
    return false;
  });
  return [...uniqueMessages, ...previous];
}
