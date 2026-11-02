import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogProfileRelation,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { projectCatalogItemForDisplay } from "../../../../src/chat/session-catalog-display.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { lookupCatalogSession } from "../../lib/sessions/catalog-read.runtime.ts";
import { catalogMessageId } from "./catalog-message-id.ts";
import type { ChatPaneStateOwner } from "./chat-pane-state-owner.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { scheduleChatScroll } from "./scroll.ts";

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

/** Execute only an admitted catalog read; pane ownership stays with the caller. */
export async function loadCatalogSessionPage({
  agentId,
  client,
  key,
  profileRelation,
  signal,
  isCurrent,
  older,
  history,
  olderCursorsSeen,
  state,
}: {
  agentId: string;
  client: Pick<GatewayBrowserClient, "request">;
  key: CatalogSessionKey;
  profileRelation?: SessionCatalogProfileRelation;
  signal: AbortSignal;
  isCurrent: () => boolean;
  older: boolean;
  history: ChatPaneStateOwner["history"];
  olderCursorsSeen: Set<string>;
  state: ChatPageHost;
}): Promise<boolean> {
  if (!older) {
    const lookup = await lookupCatalogSession({
      agentId,
      client,
      key,
      profileRelation,
      isCurrent,
      signal,
    });
    if (!lookup || !isCurrent()) {
      return false;
    }
    history.catalogHost = lookup.host;
    history.catalogSession = lookup.session;
  }
  const requestedOlderCursor = older ? history.catalogCursor : undefined;
  const page = await client.request<SessionsCatalogReadResult>(
    "sessions.catalog.read",
    {
      agentId,
      catalogId: key.catalogId,
      hostId: key.hostId,
      threadId: key.threadId,
      ...(profileRelation ? { profileRelation } : {}),
      ...(history.catalogSession?.sourceHomeId
        ? { sourceHomeId: history.catalogSession.sourceHomeId }
        : {}),
      limit: 50,
      ...(older && history.catalogCursor ? { cursor: history.catalogCursor } : {}),
    },
    { signal },
  );
  if (!isCurrent()) {
    return false;
  }
  // Only accepted pages advance progress. A cancelled read must leave its
  // cursor reusable instead of falsely exhausting a later retry.
  if (requestedOlderCursor) {
    olderCursorsSeen.add(requestedOlderCursor);
  }
  const messages = page.items
    .toReversed()
    .map((item) => catalogItemMessage(item))
    .filter((message) => message !== null);
  const nextMessages = older
    ? prependUniqueCatalogMessages(messages, history.catalogMessages)
    : messages;
  const addedMessages = nextMessages.length > history.catalogMessages.length;
  // Exhaust when the cursor cannot make new forward progress: absent, unchanged,
  // or already visited this session (a provider cycling c1 -> c2 -> c1). Any of
  // these stops the re-armed observer from looping. An advancing, never-seen
  // cursor with no newly rendered messages (an entirely filtered/duplicate page)
  // must keep paging — real older history may sit behind it.
  const olderExhausted =
    older &&
    (!page.nextCursor ||
      page.nextCursor === requestedOlderCursor ||
      olderCursorsSeen.has(page.nextCursor));
  history.catalogMessages = nextMessages;
  history.catalogCursor = olderExhausted ? undefined : page.nextCursor;
  if (older) {
    history.olderError = null;
  } else {
    state.lastError = null;
  }
  scheduleChatScroll(state, !older);
  return !older || addedMessages || !olderExhausted;
}
