import { AsyncLocalStorage } from "node:async_hooks";
import { runWithCliHistoryWriter } from "./cli-history-boundary.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { OwnedSessionTranscriptWriteContext } from "./transcript-write-context.js";
import type { SessionEntry } from "./types.js";

export type TranscriptSourcePublication = {
  target: NonNullable<OwnedSessionTranscriptWriteContext["sessionTarget"]>;
  claimed: boolean;
  publish?: (source: CapturedSessionEntryReadSource, entry: SessionEntry) => void;
};

// One owner shared by writer admission and lightweight detached-work callers.
export const ownedTranscriptWriteContext = new AsyncLocalStorage<
  OwnedSessionTranscriptWriteContext & { sourcePublication?: TranscriptSourcePublication }
>();

/** Runs detached work without retaining an attempt-owned transcript context. */
export function runWithoutOwnedSessionTranscriptWrites<T>(run: () => T): T {
  return ownedTranscriptWriteContext.exit(() => runWithCliHistoryWriter(undefined, run));
}
