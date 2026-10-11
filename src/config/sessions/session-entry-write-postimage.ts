import type { SessionEntryWindowRow } from "./session-entry-window.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Exact persisted facts retained by the synchronous transaction that wrote them. */
export type SessionEntryWritePostimage = {
  changed: boolean;
  entry: SessionEntry;
  window: SessionEntryWindowRow;
  sideTables: {
    memberIdsJson: string;
    hasBoard: boolean;
  };
};

export type SessionEntryWritePostimages = Map<string, SessionEntryWritePostimage>;
