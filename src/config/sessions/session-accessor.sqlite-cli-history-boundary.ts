import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  getCliHistoryWriter,
  advanceCliHistoryBoundary,
  type CliHistoryWriterFacts,
} from "./cli-history-boundary.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { InternalSessionEntry } from "./types.js";

/** Advance only a contiguous prefix written by the exact prepared CLI account's live owner. */
export function advanceCliHistoryBoundaryInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  seq: number,
): void {
  const writer = getCliHistoryWriter({ ...scope, storePath: database.path });
  if (writer) {
    advanceCliHistoryBoundaryRangeInTransaction(
      database,
      scope,
      { first: seq, last: seq },
      writer,
      writer.assertCurrent,
    );
  }
}

/** A worker carries account facts; its host-held live owner still grants this exact commit. */
export function advanceCliHistoryBoundaryRangeInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  range: { first: number; last: number },
  writer: CliHistoryWriterFacts,
  assertCurrent: () => void,
): boolean {
  if (range.last < range.first) {
    return false;
  }
  const entry: InternalSessionEntry | undefined = readSessionEntryRow(
    database,
    scope.sessionKey,
  )?.entry;
  const generation = readTranscriptGenerationInTransaction(database, scope.sessionId);
  const next = advanceCliHistoryBoundary(entry, scope.sessionId, generation ?? null, range, writer);
  if (!next) {
    return false;
  }
  assertCurrent();
  writeSessionEntry(database, scope.sessionKey, next, { previousEntry: entry });
  return true;
}
