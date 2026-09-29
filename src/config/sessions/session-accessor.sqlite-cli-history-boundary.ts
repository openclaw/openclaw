import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  getCliHistoryWriter,
  isKnownCliHistoryBoundary,
  type CliHistoryWriter,
} from "./cli-history-boundary.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { InternalSessionEntry } from "./types.js";

export type CliHistoryWriterFacts = Pick<
  CliHistoryWriter,
  "runId" | "authFingerprint" | "lifecycleRevision" | "expectedWriterRunId"
>;

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
  const boundary = entry?.cliHistoryBoundary;
  const generation = readTranscriptGenerationInTransaction(database, scope.sessionId);
  if (
    !entry ||
    !isKnownCliHistoryBoundary(boundary) ||
    entry.sessionId !== scope.sessionId ||
    boundary.sessionId !== scope.sessionId ||
    entry.activeWriterRunId !== writer.expectedWriterRunId ||
    entry.lifecycleRevision !== writer.lifecycleRevision ||
    boundary.writerRunId !== writer.runId ||
    boundary.authFingerprint !== writer.authFingerprint ||
    (boundary.maxSeq === null ? range.first !== 0 : boundary.maxSeq !== range.first - 1) ||
    !generation ||
    (boundary.generation === null ? range.first !== 0 : boundary.generation !== generation)
  ) {
    return false;
  }
  assertCurrent();
  writeSessionEntry(
    database,
    scope.sessionKey,
    {
      ...entry,
      cliHistoryBoundary: { ...boundary, generation, maxSeq: range.last },
    } satisfies InternalSessionEntry,
    { previousEntry: entry },
  );
  return true;
}
