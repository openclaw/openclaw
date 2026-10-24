import type { ConversationRouteContext } from "./conversation-route-context.js";
import type { trackSessionEntryCacheWrite } from "./session-accessor.sqlite-entry-cache.js";
import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type { bindSessionNode, bindSessionRoot } from "./session-accessor.sqlite-session-row.js";
import type {
  SessionEntryWindowRow,
  SessionEntryWindowFacts,
} from "./session-entry-window.types.js";
import type {
  SessionEntryWritePostimage,
  SessionEntryWritePostimages,
} from "./session-entry-write-postimage.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryWriteOptions = {
  /** Only durable custody owns the native restart exclusion marker. */
  questionOwnerMutation?: boolean;
  allowStoredAliases?: boolean;
  /** Only the personal involvement owner may replace this logical-node state. */
  profileInvolvement?: SessionEntry["profileInvolvement"];
  /** Only the provider review owner may replace a generation-bound pause. */
  providerReviewMutation?: boolean;
  /** Canonical row revalidated in this write transaction; null proves absence. */
  canonicalPreviousEntry?: SessionEntry | null;
  /** Raw canonical columns from the same transaction, for exact no-op comparison. */
  canonicalPreviousRow?: ResolvedSessionEntryRow["row"];
  canonicalPreviousWindow?: SessionEntryWindowFacts;
  canonicalPreviousSideTables?: SessionEntryWritePostimage["sideTables"];
  postimages?: SessionEntryWritePostimages;
  consumePendingReset?: boolean;
  /** Initial child fork keeps this logical node's current audience across transcript installation. */
  preserveVisibility?: boolean;
  /** A rehome can bind historical windows to an otherwise unchanged target. */
  publishConversationBinding?: boolean;
  preserveNodeSuggestions?: boolean;
  previousEntry?: SessionEntry | null;
  observeConversation?: boolean;
  routeContext?: ConversationRouteContext | null;
};

export type PreparedSessionEntryWrite = {
  sessionKey: string;
  node:
    | (ReturnType<typeof bindSessionNode> & { legacy_acp_migration_json?: string | null })
    | undefined;
  window:
    | (Omit<ReturnType<typeof bindSessionRoot>, "primary_conversation_id"> & {
        primary_conversation_id: string | null;
        transcript_observed_at: number;
      })
    | undefined;
  windowPostimage: SessionEntryWindowRow;
  setWindowPostimage(postimage: SessionEntryWindowRow): void;
  batchable: boolean;
  write(): ReturnType<typeof trackSessionEntryCacheWrite>;
  publish(writeGeneration: ReturnType<typeof trackSessionEntryCacheWrite>): SessionEntry;
};
