import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatHistoryState, ChatTranscriptMetadata } from "./chat-transcript-metadata.ts";

export type ChatSessionSnapshot = {
  widgetHeights?: Record<string, number>;
  transcriptMetadata?: ChatTranscriptMetadata;
  progressCard?: ProgressCard | null;
  deltaCursor?: string;
  historyState?: ChatHistoryState;
  displayedLeafEntryId?: string | null;
  messages: unknown[];
  pagination: ChatHistoryPagination;
  sessionId: string | null;
};
