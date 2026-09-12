import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventId,
  readTranscriptStorageRows,
} from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  canonicalizeTranscriptEventMedia,
  readEventTimestamp,
} from "./session-accessor.sqlite-transcript-store.js";
import type { SessionTranscriptIndexProjection } from "./session-transcript-index.js";
import {
  extractTranscriptIndexEntry,
  hasTranscriptMessage,
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-rebuild.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export function prepareTranscriptIndexProjection(
  events: readonly TranscriptEvent[],
  seqByIndex: readonly number[],
  createdAtByIndex: readonly number[],
): SessionTranscriptIndexProjection {
  const tree = scanSessionTranscriptTree(events);
  const visibleIndexes =
    tree.nodes.length > 0
      ? selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.index)
      : tree.hasLeafControl
        ? []
        : events.map((_event, index) => index);
  const activeRows: SessionTranscriptIndexProjection["activeRows"] = [];
  let activeMessageCount = 0;
  for (const index of visibleIndexes) {
    const event = events[index];
    if (!shouldProjectActiveEvent(event)) {
      continue;
    }
    const messagePosition = hasTranscriptMessage(event) ? activeMessageCount++ : null;
    const createdAt = createdAtByIndex[index] ?? Date.now();
    const ftsEntry = extractTranscriptIndexEntry(event, createdAt);
    activeRows.push({
      activePosition: activeRows.length,
      contextEligible: transcriptEventContextEligibility(event),
      eventSeq: seqByIndex[index] ?? index,
      messagePosition,
      ...(ftsEntry ? { ftsEntry } : {}),
    });
  }
  return {
    activeMessageCount,
    activeRows,
    indexedSeq: seqByIndex.at(-1) ?? -1,
    leafEventId: tree.appendParentId,
  };
}

export function prepareFullTranscriptSuffixMutation(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
) {
  const expectedRows = readTranscriptStorageRows(database, resolved.sessionId);
  const expected = expectedEvents.map(canonicalizeTranscriptEventMedia);
  const next = nextEvents.map(canonicalizeTranscriptEventMedia);
  const expectedJson = expected.map((event) => JSON.stringify(event));
  if (
    expectedRows.length !== expectedJson.length ||
    expectedRows.some((row, index) => row.eventJson !== expectedJson[index])
  ) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${resolved.sessionId}`,
    );
  }

  const nextJson = next.map((event) => JSON.stringify(event));
  let prefixLength = 0;
  while (
    prefixLength < expectedJson.length &&
    prefixLength < nextJson.length &&
    expectedJson[prefixLength] === nextJson[prefixLength]
  ) {
    prefixLength += 1;
  }
  const unchanged = prefixLength === expectedJson.length && prefixLength === nextJson.length;
  if (!unchanged && (next.length > expected.length || prefixLength === 0)) {
    throw new Error(
      `Transcript mutation is not a bounded suffix removal for ${resolved.sessionId}`,
    );
  }

  const startSeq = expectedRows[prefixLength]?.seq ?? (expectedRows.at(-1)?.seq ?? -1) + 1;
  const nextSeqByIndex = next.map((_event, index) =>
    index < prefixLength ? (expectedRows[index]?.seq ?? index) : startSeq + index - prefixLength,
  );
  const previousProjection = prepareTranscriptIndexProjection(
    expected,
    expectedRows.map((row) => row.seq),
    expectedRows.map((row) => row.createdAt),
  );
  const storedCreatedAtByEventId = new Map(
    expected.flatMap((event, index) => {
      const eventId = readTranscriptEventId(event);
      const createdAt = expectedRows[index]?.createdAt;
      return eventId && createdAt !== undefined ? [[eventId, createdAt] as const] : [];
    }),
  );
  const nextCreatedAt = next.map((event, index) => {
    if (index < prefixLength) {
      return expectedRows[index]?.createdAt ?? Date.now();
    }
    const eventId = readTranscriptEventId(event);
    return (
      (eventId ? storedCreatedAtByEventId.get(eventId) : undefined) ??
      readEventTimestamp(event) ??
      Date.now()
    );
  });
  return {
    expectedRows,
    next,
    nextCreatedAt,
    nextProjection: prepareTranscriptIndexProjection(next, nextSeqByIndex, nextCreatedAt),
    prefixLength,
    previousProjection,
    startSeq,
  };
}
