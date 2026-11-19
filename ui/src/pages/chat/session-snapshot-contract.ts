import type { MessageReactionSummary, ProgressCard } from "@openclaw/gateway-protocol";
import type { GatewaySessionRow, ModelCatalogEntry } from "../../api/types.ts";
import type { ChatFastModePresentation } from "../../lib/chat/model-select-state.ts";
import type { ChatRowDisplayFacts } from "../../lib/chat/row-display-facts.ts";
import type {
  ChatHeaderSharingSnapshot,
  ChatHeaderViewersSnapshot,
} from "./chat-header-viewers-snapshot.ts";
import type { ChatHistoryPagination } from "./chat-history-pagination.ts";
import type { ChatSessionStateSnapshot } from "./chat-session-state-snapshot.ts";
import type { ChatHistoryState, ChatTranscriptMetadata } from "./chat-transcript-metadata.ts";
import type { ChatDetailsSnapshot } from "./session-details-snapshot-schema.ts";

// Display only: the live catalog and session owners still admit every action.
export type ChatComposerSnapshot = Pick<
  ModelCatalogEntry,
  "id" | "provider" | "name" | "reasoning"
> &
  Pick<
    GatewaySessionRow,
    "thinkingLevel" | "thinkingLevels" | "thinkingDefault" | "permissionMode"
  > & {
    defaultPermissionMode?: GatewaySessionRow["permissionMode"];
    contextWindowDisplay?: Pick<
      GatewaySessionRow,
      "contextWindow" | "contextWindowDefault" | "contextWindows"
    >;
    speed?: ChatFastModePresentation;
  };

export type ChatSessionSnapshot = {
  sessionState?: ChatSessionStateSnapshot;
  headerViewers?: ChatHeaderViewersSnapshot;
  headerSharing?: ChatHeaderSharingSnapshot | null;
  details?: ChatDetailsSnapshot;
  rowDisplay?: Record<string, ChatRowDisplayFacts>;
  avatarSources?: Record<string, string | null>;
  composer?: ChatComposerSnapshot | null;
  // The board provider validates cached payloads before they can reach a view.
  board?: { snapshot: unknown; receivedAtMs: number } | null;
  widgetHeights?: Record<string, number>;
  transcriptMetadata?: ChatTranscriptMetadata;
  messageReactions?: Record<string, MessageReactionSummary[]>;
  progressCard?: ProgressCard | null;
  deltaCursor?: string;
  historyState?: ChatHistoryState;
  displayedLeafEntryId?: string | null;
  messages: unknown[];
  pagination: ChatHistoryPagination;
  sessionId: string | null;
};
