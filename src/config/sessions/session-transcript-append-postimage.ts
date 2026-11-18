import type { SqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type TranscriptAppendPostimage = {
  revision: SqliteReadScopeRevision;
  version: SessionTranscriptContextVersion;
  anchor: TranscriptEntryAnchor;
};

// Receipts follow the local result object without expanding released return shapes or crossing IPC.
const postimages = new WeakMap<object, TranscriptAppendPostimage>();

export function retainTranscriptAppendPostimage<T extends object>(
  result: T,
  postimage: TranscriptAppendPostimage | undefined,
): T {
  if (postimage) {
    postimages.set(result, postimage);
  }
  return result;
}

export function readTranscriptAppendPostimage(result: unknown) {
  return result !== null && typeof result === "object" ? postimages.get(result) : undefined;
}
