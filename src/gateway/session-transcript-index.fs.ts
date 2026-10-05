import fs from "node:fs";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptDisplayPosition } from "../chat/transcript-display-position.js";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { selectSessionTranscriptActiveEntries } from "../config/sessions/transcript-tree.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { readNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  createTranscriptDisplayPositionFromActivity,
  createTranscriptDisplaySource,
  type TranscriptDisplayActivity,
} from "../sessions/transcript-display-position.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import {
  parseTranscriptRecord,
  type TranscriptRecord,
} from "./session-transcript-record-parser.js";
import {
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
} from "./session-transcript-source-pages.js";

export type IndexedTranscriptEntry = {
  id?: string;
  /** Selection sometimes compares the raw ID, including blank strings. */
  rawId?: string;
  offset: number;
  /** Physical bytes, distinct from the parser's decoded/sanitized byteLength. */
  length: number;
  seq: number;
  transcriptPosition: TranscriptDisplayPosition;
};

export type MaterializedTranscriptEntry = TranscriptRecord & IndexedTranscriptEntry;

export type SessionTranscriptIndex = {
  entries: IndexedTranscriptEntry[];
  byId: Map<string, IndexedTranscriptEntry>;
  displaySource: string;
};

type ArchiveNavigationEntry = TranscriptRecord & {
  rawSeq: number;
  offset: number;
  length: number;
  activity?: TranscriptDisplayActivity;
};

type TranscriptIndexPreparation = {
  offset: number;
  lineOffset: number;
  length: number;
  afterCr: boolean;
  fragments: Buffer[];
  records: ArchiveNavigationEntry[];
  rawSeqById: Map<string, number>;
};

type CachedTranscriptIndex = {
  identity: string;
  size: number;
  largestLine: number;
  preparation?: TranscriptIndexPreparation;
  value?: SessionTranscriptIndex;
  pending?: Promise<void>;
};

const transcriptIndexes = new Map<string, CachedTranscriptIndex>();
const MAX_TRANSCRIPT_INDEXES = 256;
const ARCHIVE_READ_BYTES = 64 * 1024;
const ARCHIVE_BATCH_BYTES = 1024 * 1024;

function transcriptArtifactDisplaySource(filePath: string, stat: fs.Stats): string {
  // Inode/ctime distinguish replacement or rewrite even when size and mtime are preserved.
  const identity = `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
  return createTranscriptDisplaySource(["archive", filePath, identity]);
}

export function assertArchiveTranscriptSource(
  filePath: string,
  stat: fs.Stats,
  displaySource: string,
  sessionId: string,
): void {
  if (transcriptArtifactDisplaySource(filePath, stat) !== displaySource) {
    throw new SessionTranscriptProjectionUnavailableError(sessionId);
  }
}

export function selectArchiveTranscriptEntries<T extends TranscriptRecord>(
  records: T[],
  failClosedOnInvalidLeafControl = false,
): T[] {
  const entries = selectSessionTranscriptActiveEntries({
    entries: records,
    recordOf: (entry) => entry.record,
    failClosedOnInvalidLeafControl,
  });
  const boundaryIndex = entries.findLastIndex(({ record }) => {
    return record.type === "compaction" || record.type === "reset";
  });
  if (boundaryIndex < 0 || entries[boundaryIndex]?.record.type !== "reset") {
    return entries;
  }
  const firstKeptEntryId = entries[boundaryIndex]?.record.firstKeptEntryId;
  const firstKeptIndex =
    typeof firstKeptEntryId === "string"
      ? entries.findIndex((entry, index) => index < boundaryIndex && entry.id === firstKeptEntryId)
      : -1;
  const kept =
    firstKeptIndex < 0
      ? []
      : entries.slice(firstKeptIndex, boundaryIndex).filter(({ record }) => {
          const role = asOptionalRecord(record.message)?.role;
          return role === "user" || role === "assistant";
        });
  return [...kept, ...entries.slice(boundaryIndex)];
}

function archiveNavigationRecord(record: Record<string, unknown>): Record<string, unknown> {
  const navigation: Record<string, unknown> = {};
  for (const key of [
    "id",
    "type",
    "parentId",
    "targetId",
    "appendParentId",
    "appendMode",
    "firstKeptEntryId",
  ]) {
    if (Object.hasOwn(record, key)) {
      const value = record[key];
      navigation[key] = typeof value === "string" || value === null ? value : false;
    }
  }
  // The tree/reset selector needs message presence and role, never its payload.
  const role = asOptionalRecord(record.message)?.role;
  navigation.message = record.message
    ? { role: role === "user" || role === "assistant" ? role : undefined }
    : false;
  if (record.type === "custom_message") {
    navigation.display = record.display === true;
    navigation.customType = record.customType;
  }
  return navigation;
}

function appendArchiveNavigationRecord(state: TranscriptIndexPreparation) {
  const line = Buffer.concat(state.fragments, state.length).toString("utf8");
  const record = line.trim() ? parseTranscriptRecord(line) : null;
  if (!record) {
    return;
  }
  const rawSeq = state.records.length + 1;
  const activity = readNestedToolActivity(record.record.message)?.details;
  state.records.push({
    ...record,
    record: archiveNavigationRecord(record.record),
    rawSeq,
    offset: state.lineOffset,
    length: state.length,
    ...(activity
      ? {
          activity: {
            afterEntryId: activity.afterEntryId,
            scopeId: activity.scopeId,
            startOrder: activity.startOrder,
          },
        }
      : {}),
  });
  if (record.id) {
    // Capture physical cuts before branch/reset selection removes their control rows.
    state.rawSeqById.set(record.id, rawSeq);
  }
}

function finishSessionTranscriptIndex(
  { records, rawSeqById }: TranscriptIndexPreparation,
  displaySource: string,
): SessionTranscriptIndex {
  const entries = selectArchiveTranscriptEntries(records)
    .filter((entry) => isVisibleTranscriptRecord(entry.record))
    .map((entry, index): IndexedTranscriptEntry => ({
      id: entry.id,
      rawId: typeof entry.record.id === "string" ? entry.record.id : undefined,
      offset: entry.offset,
      length: entry.length,
      seq: index + 1,
      transcriptPosition: createTranscriptDisplayPositionFromActivity(
        displaySource,
        entry.rawSeq,
        entry.activity,
        (id) => rawSeqById.get(id),
      ),
    }));
  return {
    entries,
    byId: new Map(entries.flatMap((entry) => (entry.id ? [[entry.id, entry] as const] : []))),
    displaySource,
  };
}

function assertSourceLineBound(length: number) {
  if (length > SOURCE_PAGE_MAX_BYTES) {
    throw new Error(
      `Transcript source message exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte page limit`,
    );
  }
}

async function prepareTranscriptIndexStep(
  filePath: string,
  cached: CachedTranscriptIndex,
  sessionId: string,
  bounded: boolean,
): Promise<void> {
  const state = cached.preparation!;
  const handle = await fs.promises.open(filePath, "r");
  try {
    assertArchiveTranscriptSource(filePath, await handle.stat(), cached.identity, sessionId);
    // Count retained bytes too: finishing a partial line must not decode a second page's payload.
    let bytes = bounded ? state.length : 0;
    let lines = 0;
    scan: while (state.offset < cached.size && lines < SOURCE_PAGE_MAX_MESSAGES) {
      const remaining = SOURCE_PAGE_MAX_BYTES - bytes;
      if (remaining <= 0 && (!bounded || state.length < SOURCE_PAGE_MAX_BYTES)) {
        break;
      }
      // At the line limit, inspect only its delimiter; another payload byte must fail closed.
      const length = Math.min(
        ARCHIVE_READ_BYTES,
        Math.max(1, remaining),
        cached.size - state.offset,
      );
      const chunk = Buffer.allocUnsafe(length);
      if ((await readFileWindowFully(handle, chunk, state.offset)) !== length) {
        throw new SessionTranscriptProjectionUnavailableError(sessionId);
      }
      bytes += length;
      let start = 0;
      if (state.afterCr) {
        if (chunk[0] === 10) {
          start++;
          state.offset++;
          state.lineOffset++;
        }
        state.afterCr = false;
      }
      while (start < chunk.length && lines < SOURCE_PAGE_MAX_MESSAGES) {
        const lf = chunk.indexOf(10, start);
        const cr = chunk.indexOf(13, start);
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        const fragmentEnd = end < 0 ? chunk.length : end;
        const fragment = chunk.subarray(start, fragmentEnd);
        cached.largestLine = Math.max(cached.largestLine, state.length + fragment.length);
        if (bounded && cached.largestLine > SOURCE_PAGE_MAX_BYTES) {
          break scan;
        }
        state.fragments.push(fragment);
        state.length += fragment.length;
        state.offset += fragment.length;
        if (end < 0) {
          break;
        }
        appendArchiveNavigationRecord(state);
        lines++;
        state.fragments = [];
        state.length = 0;
        state.offset++;
        start = end + 1;
        state.afterCr = chunk[end] === 13;
        if (state.afterCr && start < chunk.length) {
          if (chunk[start] === 10) {
            start++;
            state.offset++;
          }
          state.afterCr = false;
        }
        state.lineOffset = state.offset;
      }
    }
    if (state.offset === cached.size) {
      if (state.length > 0) {
        appendArchiveNavigationRecord(state);
      }
      cached.value = finishSessionTranscriptIndex(state, cached.identity);
      cached.preparation = undefined;
    }
    assertArchiveTranscriptSource(filePath, await handle.stat(), cached.identity, sessionId);
  } finally {
    await handle.close();
  }
}

function advanceTranscriptIndex(
  filePath: string,
  cached: CachedTranscriptIndex,
  sessionId: string,
  bounded: boolean,
): Promise<void> {
  return (cached.pending ??= prepareTranscriptIndexStep(filePath, cached, sessionId, bounded)
    .catch((error: unknown) => {
      if (transcriptIndexes.get(filePath) === cached) {
        transcriptIndexes.delete(filePath);
      }
      throw error;
    })
    .finally(() => {
      cached.pending = undefined;
    }));
}

/** Read selected payloads in bounded asynchronous batches; the cache owns no payload objects. */
export async function readIndexedTranscriptEntries(
  filePath: string,
  index: SessionTranscriptIndex,
  selected: readonly IndexedTranscriptEntry[],
  sessionId: string,
): Promise<MaterializedTranscriptEntry[]> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    assertArchiveTranscriptSource(filePath, await handle.stat(), index.displaySource, sessionId);
    const physical = selected
      .map((entry, order) => ({ entry, order }))
      .toSorted((left, right) => left.entry.offset - right.entry.offset);
    const result: MaterializedTranscriptEntry[] = [];
    for (let start = 0; start < physical.length;) {
      const first = physical[start]!.entry;
      let end = start + 1;
      let byteEnd = first.offset + first.length;
      while (end < physical.length) {
        const next = physical[end]!.entry;
        if (next.offset + next.length - first.offset > ARCHIVE_BATCH_BYTES) {
          break;
        }
        byteEnd = Math.max(byteEnd, next.offset + next.length);
        end++;
      }
      // One oversized record still follows the existing parser's recovery contract.
      const buffer = Buffer.allocUnsafe(byteEnd - first.offset);
      if ((await readFileWindowFully(handle, buffer, first.offset)) !== buffer.length) {
        throw new SessionTranscriptProjectionUnavailableError(sessionId);
      }
      for (let position = start; position < end; position++) {
        const { entry, order } = physical[position]!;
        const relative = entry.offset - first.offset;
        const parsed = parseTranscriptRecord(
          buffer.toString("utf8", relative, relative + entry.length),
        );
        if (!parsed) {
          throw new SessionTranscriptProjectionUnavailableError(sessionId);
        }
        result[order] = { ...entry, ...parsed };
      }
      start = end;
    }
    assertArchiveTranscriptSource(filePath, await handle.stat(), index.displaySource, sessionId);
    return result;
  } finally {
    await handle.close();
  }
}

async function acquireTranscriptIndex(filePath: string): Promise<CachedTranscriptIndex | null> {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    transcriptIndexes.delete(filePath);
    return null;
  }
  const identity = transcriptArtifactDisplaySource(filePath, stat);
  let cached = transcriptIndexes.get(filePath);
  if (cached?.identity !== identity) {
    cached = {
      identity,
      size: stat.size,
      largestLine: 0,
      preparation: {
        offset: 0,
        lineOffset: 0,
        length: 0,
        afterCr: false,
        fragments: [],
        records: [],
        rawSeqById: new Map(),
      },
    };
  }
  transcriptIndexes.delete(filePath);
  transcriptIndexes.set(filePath, cached);
  // Preparation retains no descriptor; eviction drops partial bytes and navigation metadata together.
  pruneMapToMaxSize(transcriptIndexes, MAX_TRANSCRIPT_INDEXES);
  return cached;
}

/** One source call prepares at most one page; pending callers never join an unbounded reader. */
export async function prepareSessionTranscriptIndex(
  filePath: string,
  sessionId: string,
): Promise<{ displaySource: string; index?: SessionTranscriptIndex } | null> {
  const cached = await acquireTranscriptIndex(filePath);
  if (!cached) {
    return null;
  }
  try {
    assertSourceLineBound(cached.largestLine);
    if (cached.pending) {
      return { displaySource: cached.identity };
    }
    if (cached.value) {
      return { displaySource: cached.identity, index: cached.value };
    }
    await advanceTranscriptIndex(filePath, cached, sessionId, true);
    assertSourceLineBound(cached.largestLine);
    // Keep payload reads out of the preparation budget, including the final preparation step.
    return { displaySource: cached.identity };
  } catch (error) {
    // Source policy cannot invalidate an index still usable by ordinary archive readers.
    if (!cached.value && !cached.pending && transcriptIndexes.get(filePath) === cached) {
      transcriptIndexes.delete(filePath);
    }
    throw error;
  }
}

export async function readSessionTranscriptIndex(
  filePath: string,
  sessionId: string,
): Promise<SessionTranscriptIndex | null> {
  const cached = await acquireTranscriptIndex(filePath);
  if (!cached) {
    return null;
  }
  // By-ID/recent archive reads retain the parser's oversized multimodal recovery contract.
  while (!cached.value || cached.pending) {
    await advanceTranscriptIndex(filePath, cached, sessionId, false);
  }
  return cached.value;
}
