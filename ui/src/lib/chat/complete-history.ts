import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import type { ChatHistoryResult } from "../../pages/chat/chat-history-snapshot.ts";
import { nativeHistoryMessageIdentity } from "./history-message-identity.ts";

registerSessionOrganizationEnglish();

/** Read one coherent conversation independently of the rendered history window. */
export async function loadCompleteChatHistory({
  client,
  sessionKey,
  sessionId,
  agentId,
  isCurrent,
}: {
  client: GatewayBrowserClient;
  sessionKey: string;
  sessionId?: string | null;
  agentId?: string;
  isCurrent: () => boolean;
}): Promise<unknown[]> {
  const pages: unknown[][] = [];
  const seenCounts = new Map<string, number>();
  const requestHistory = (offset: number, limit = 1000) =>
    client.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      agentId,
      limit,
      maxChars: 500_000,
      offset,
    });
  let offset = 0;
  let snapshot: ChatHistoryResult | undefined;
  while (true) {
    const page = await requestHistory(offset);
    // Offsets are relative to the current tail. Never stitch different sessions,
    // branches, or growing transcripts into a seemingly complete export.
    if (
      !isCurrent() ||
      (sessionId && page.sessionId !== sessionId) ||
      (snapshot &&
        (page.sessionId !== snapshot.sessionId || page.totalMessages !== snapshot.totalMessages))
    ) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    snapshot ??= page;
    const pageCounts = new Map<string, number>();
    const messages = (page.messages ?? []).filter((message) => {
      const identity = nativeHistoryMessageIdentity(message);
      if (!identity) {
        return true;
      }
      const count = (pageCounts.get(identity) ?? 0) + 1;
      pageCounts.set(identity, count);
      return count > (seenCounts.get(identity) ?? 0);
    });
    for (const [identity, count] of pageCounts) {
      seenCounts.set(identity, Math.max(count, seenCounts.get(identity) ?? 0));
    }
    pages.push(messages);
    if (!page.hasMore) {
      break;
    }
    if (page.nextOffset === undefined || page.nextOffset <= offset) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    offset = page.nextOffset;
  }
  if (pages.length > 1) {
    // Only tail pages carry the branch marker and history cursor. Re-read the
    // tail after paging so a branch switch or rewrite cannot mix transcripts.
    const tail = await requestHistory(0, 1);
    if (
      !isCurrent() ||
      tail.sessionId !== snapshot.sessionId ||
      tail.totalMessages !== snapshot.totalMessages ||
      tail.deltaCursor !== snapshot.deltaCursor ||
      tail.sessionInfo?.activeLeafEntryId !== snapshot.sessionInfo?.activeLeafEntryId
    ) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
  }
  return pages.toReversed().flat();
}
