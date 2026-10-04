// Reads transcript artifacts; live store acquisition stays with the caller.
import fs from "node:fs";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.sqlite-contract.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  resolveHistoryAnchorPageRange,
  resolveTranscriptPageEnd,
  type TranscriptAnchorPageOptions,
  type TranscriptRecentReadLimits,
} from "../sessions/transcript-anchor-page.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import { isPreSessionStartAssistantMessage } from "./chat-display-projection.history.js";
import { projectTranscriptEntryMessage } from "./session-transcript-entry-message.js";
import { resolveSessionTranscriptResetArchiveCandidatesAsync } from "./session-transcript-files.fs.js";
import {
  assertArchiveTranscriptSource,
  prepareSessionTranscriptIndex,
  readIndexedTranscriptEntries,
  readSessionTranscriptIndex,
  selectArchiveTranscriptEntries,
  type MaterializedTranscriptEntry,
  type SessionTranscriptIndex,
} from "./session-transcript-index.fs.js";
import type {
  ReadRecentSessionMessagesOptions,
  ReadSessionMessageByIdResult,
  ReadSessionMessagesResult,
} from "./session-transcript-read.types.js";
import {
  MAX_TRANSCRIPT_PARSE_LINE_BYTES,
  parseTranscriptRecord,
} from "./session-transcript-record-parser.js";
import {
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
  type SessionTranscriptSourcePageOptions,
  type SessionTranscriptSourceSnapshot,
} from "./session-transcript-source-pages.js";

export type { ReadRecentSessionMessagesOptions } from "./session-transcript-read.types.js";

type ReadSessionMessagesPageOptions = {
  offset: number;
  maxMessages: number;
  beforeSeq?: number;
  recentAtHead?: TranscriptRecentReadLimits;
};

type ReadRecentSessionMessagesResult = {
  displaySource?: string;
  messages: unknown[];
  totalMessages: number;
  /** Raw selected transcript rows parsed from the same read as `messages`. */
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "reset-archive";
};

const RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

type ArchivedTranscriptReadScope = {
  agentId?: string | undefined;
  exactArchivePath?: string | undefined;
  sessionFile?: string | undefined;
  sessionId: string;
  storePath?: string | undefined;
};

function normalizeRecentSessionReadOptions(opts?: Partial<ReadRecentSessionMessagesOptions>) {
  const maxMessages = resolveNonNegativeIntegerOption(opts?.maxMessages, 0);
  const maxBytes = resolveIntegerOption(opts?.maxBytes, RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES, {
    min: 1024,
  });
  const maxLines = resolveIntegerOption(opts?.maxLines, maxMessages * 20 + 20, {
    min: maxMessages,
  });
  return { maxMessages, maxBytes, maxLines };
}

async function readRecentSessionSnapshotFromPathAsync(
  filePath: string,
  opts: ReturnType<typeof normalizeRecentSessionReadOptions>,
  index: SessionTranscriptIndex,
  sessionId: string,
): Promise<{ messages: unknown[]; transcriptEvents: TranscriptEvent[] }> {
  if (opts.maxMessages === 0) {
    return { messages: [], transcriptEvents: [] };
  }
  const { maxBytes, maxLines } = opts;
  const handle = await fs.promises.open(filePath, "r");
  let lines: string[];
  try {
    const stat = await handle.stat();
    assertArchiveTranscriptSource(filePath, stat, index.displaySource, sessionId);
    const readLen = Math.min(stat.size, maxBytes);
    const readStart = Math.max(0, stat.size - readLen);
    const buffer = Buffer.alloc(readLen);
    const bytesRead = await readFileWindowFully(handle, buffer, readStart);
    const finalStat = await handle.stat();
    assertArchiveTranscriptSource(filePath, finalStat, index.displaySource, sessionId);
    if (bytesRead <= 0) {
      return { messages: [], transcriptEvents: [] };
    }
    lines = buffer
      .toString("utf-8", 0, bytesRead)
      .split(/\r?\n/)
      .slice(readStart > 0 ? 1 : 0)
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines);
  } finally {
    await handle.close();
  }
  return parseRecentTranscriptTailSnapshot(lines, opts.maxMessages, index);
}

function parseRecentTranscriptTailSnapshot(
  lines: string[],
  maxMessages: number,
  index: SessionTranscriptIndex,
): { messages: unknown[]; transcriptEvents: TranscriptEvent[] } {
  const entries = lines.flatMap((line) => {
    const entry = parseTranscriptRecord(line);
    return entry ? [entry] : [];
  });
  const selected = selectArchiveTranscriptEntries(entries, true);
  const recent = selected
    .filter((entry) => isVisibleTranscriptRecord(entry.record))
    .slice(-maxMessages);
  const firstSeq = Math.max(1, index.entries.length - recent.length + 1);
  return {
    messages: recent.flatMap((entry, offset) => {
      // Reuse indexed placement, never indexed payloads: the tail's byte/line bounds still own this read.
      const indexed = entry.id ? index.byId.get(entry.id) : undefined;
      const message = projectTranscriptEntryMessage(
        entry.record,
        indexed?.seq ?? firstSeq + offset,
        indexed?.transcriptPosition,
      );
      return message ? [message] : [];
    }),
    transcriptEvents: selected.map((entry) => entry.record),
  };
}

/** Reads retained reset archives after the caller has selected its SQLite fallback. */
export class ArchivedTranscriptReader {
  constructor(private readonly scope: ArchivedTranscriptReadScope) {}

  private async resolvePath(): Promise<string | null> {
    if (this.scope.exactArchivePath) {
      const exactPath = this.scope.exactArchivePath;
      if ((await fs.promises.stat(exactPath).catch(() => null))?.isFile()) {
        return materializeSessionArchiveForRead(exactPath);
      }
      return null;
    }
    const archives = await resolveSessionTranscriptResetArchiveCandidatesAsync(
      this.scope.sessionId,
      this.scope.storePath,
      this.scope.sessionFile,
      this.scope.agentId,
    );
    for (const archivePath of archives) {
      if (!(await fs.promises.stat(archivePath).catch(() => null))?.isFile()) {
        continue;
      }
      try {
        return materializeSessionArchiveForRead(archivePath);
      } catch {
        continue;
      }
    }
    return null;
  }

  async readSourcePage(
    opts: SessionTranscriptSourcePageOptions,
    snapshot: SessionTranscriptSourceSnapshot,
  ): Promise<ReadSessionMessagesResult> {
    const cursor = opts.cursor?.kind === "archive" ? opts.cursor : undefined;
    const filePath = cursor?.path ?? (await this.resolvePath());
    const nextBranch =
      opts.includeOffPathMessages && snapshot.indexedSeq >= 0
        ? { kind: "off-path" as const, snapshot, position: -1, messageSeq: snapshot.totalMessages }
        : undefined;
    if (!filePath) {
      return { messages: [], nextCursor: nextBranch };
    }
    const prepared = await prepareSessionTranscriptIndex(filePath, this.scope.sessionId);
    if (cursor && prepared?.displaySource !== cursor.source) {
      throw new Error("Transcript archive changed during source pagination; retry the read");
    }
    const start = cursor?.position ?? 0;
    if (prepared && !prepared.index) {
      return {
        messages: [],
        transcriptPath: filePath,
        nextCursor: {
          kind: "archive",
          snapshot,
          position: start,
          messageSeq: 0,
          path: filePath,
          source: prepared.displaySource,
        },
      };
    }
    const index = prepared?.index;
    let end = start;
    let bytes = 0;
    while (index && end < index.entries.length && end - start < SOURCE_PAGE_MAX_MESSAGES) {
      const size = index.entries[end]!.length;
      if (bytes + size > SOURCE_PAGE_MAX_BYTES) {
        break;
      }
      bytes += size;
      end++;
    }
    return {
      messages: index
        ? (
            await readIndexedTranscriptEntries(
              filePath,
              index,
              index.entries.slice(start, end),
              this.scope.sessionId,
            )
          ).flatMap(indexedTranscriptEntryToMessages)
        : [],
      transcriptPath: filePath,
      nextCursor:
        index && end < index.entries.length
          ? {
              kind: "archive",
              snapshot,
              position: end,
              messageSeq: 0,
              path: filePath,
              source: index.displaySource,
            }
          : nextBranch,
    };
  }

  async readById(
    messageId: string,
    historyVisibility?: { sessionStartedAt?: number },
  ): Promise<ReadSessionMessageByIdResult> {
    const filePath = await this.resolvePath();
    if (!filePath) {
      return { oversized: false, found: false };
    }
    const index = await readSessionTranscriptIndex(filePath, this.scope.sessionId);
    const selected = index?.byId.get(messageId);
    if (!index || !selected) {
      return { oversized: false, found: false };
    }
    const [entry] = await readIndexedTranscriptEntries(
      filePath,
      index,
      [selected],
      this.scope.sessionId,
    );
    if (!entry) {
      return { oversized: false, found: false };
    }
    // Raw-byte limits still reject placeholders; only bounded, validated image recoveries qualify.
    const oversized =
      entry.byteLength > MAX_TRANSCRIPT_PARSE_LINE_BYTES &&
      (entry.recoveredImageData !== true ||
        jsonUtf8Bytes(entry.record) > MAX_TRANSCRIPT_PARSE_LINE_BYTES);
    if (oversized && !historyVisibility) {
      return { oversized: true, found: true, seq: entry.seq };
    }
    const message = indexedTranscriptEntryToMessage(entry);
    const preceding =
      historyVisibility &&
      isPreSessionStartAssistantMessage(message, historyVisibility.sessionStartedAt)
        ? index.entries[entry.seq - 2]
        : undefined;
    const previous = preceding
      ? (await readIndexedTranscriptEntries(filePath, index, [preceding], this.scope.sessionId))[0]
      : undefined;
    return {
      message,
      seq: entry.seq,
      oversized,
      found: true,
      ...(historyVisibility
        ? {
            historyContext: {
              transcriptPath: filePath,
              displaySource: index.displaySource,
              ...(previous ? { precedingMessage: indexedTranscriptEntryToMessage(previous) } : {}),
            },
          }
        : {}),
    };
  }

  async readMessageCandidatesById(messageId: string): Promise<unknown[]> {
    const filePath = await this.resolvePath();
    if (!filePath) {
      return [];
    }
    const index = await readSessionTranscriptIndex(filePath, this.scope.sessionId);
    if (!index) {
      return [];
    }
    // Preserve duplicate/oversized full-reader entries and ID-less rows whose
    // projected metadata can supply the ID. The caller matches after projection.
    const entries = await readIndexedTranscriptEntries(
      filePath,
      index,
      index.entries.filter((entry) => entry.rawId === undefined || entry.rawId === messageId),
      this.scope.sessionId,
    );
    return entries.flatMap(indexedTranscriptEntryToMessages);
  }

  async readRecentWithStats(
    opts: ReadRecentSessionMessagesOptions,
  ): Promise<ReadRecentSessionMessagesResult> {
    const filePath = await this.resolvePath();
    if (!filePath) {
      return { messages: [], totalMessages: 0 };
    }
    const transcriptIndex = await readSessionTranscriptIndex(filePath, this.scope.sessionId);
    const totalMessages = transcriptIndex?.entries.length ?? 0;
    const normalized = normalizeRecentSessionReadOptions(opts);
    const snapshot = !transcriptIndex
      ? { messages: [], transcriptEvents: [] }
      : await readRecentSessionSnapshotFromPathAsync(
          filePath,
          normalized,
          transcriptIndex,
          this.scope.sessionId,
        );
    return {
      displaySource: transcriptIndex?.displaySource,
      messages: snapshot.messages,
      transcriptEvents: snapshot.transcriptEvents,
      totalMessages,
      transcriptPath: filePath,
      transcriptSource: "reset-archive",
    };
  }

  async readPage(opts: ReadSessionMessagesPageOptions): Promise<ReadRecentSessionMessagesResult> {
    const filePath = await this.resolvePath();
    if (!filePath) {
      return { messages: [], totalMessages: 0 };
    }
    const index = await readSessionTranscriptIndex(filePath, this.scope.sessionId);
    if (!index) {
      return { messages: [], totalMessages: 0, transcriptPath: filePath };
    }
    const totalMessages = index.entries.length;
    const endExclusive = resolveTranscriptPageEnd(totalMessages, opts);
    let snapshot: { messages: unknown[]; transcriptEvents: TranscriptEvent[] };
    if (opts.recentAtHead && endExclusive === totalMessages) {
      snapshot = await readRecentSessionSnapshotFromPathAsync(
        filePath,
        normalizeRecentSessionReadOptions(opts.recentAtHead),
        index,
        this.scope.sessionId,
      );
    } else {
      const start = Math.max(
        0,
        endExclusive - resolveNonNegativeIntegerOption(opts.maxMessages, 0),
      );
      const entries = await readIndexedTranscriptEntries(
        filePath,
        index,
        index.entries.slice(start, endExclusive),
        this.scope.sessionId,
      );
      snapshot = {
        messages: entries.flatMap(indexedTranscriptEntryToMessages),
        transcriptEvents: entries.map((entry) => entry.record),
      };
    }
    return {
      displaySource: index.displaySource,
      messages: snapshot.messages,
      transcriptEvents: snapshot.transcriptEvents,
      totalMessages,
      transcriptPath: filePath,
      transcriptSource: "reset-archive",
    };
  }

  async readAroundId(opts: TranscriptAnchorPageOptions): Promise<
    ReadRecentSessionMessagesResult & {
      found: boolean;
      hasOverreadContext: boolean;
      offset: number;
    }
  > {
    let displaySource: string | undefined;
    const candidates = this.scope.exactArchivePath
      ? [this.scope.exactArchivePath]
      : await resolveSessionTranscriptResetArchiveCandidatesAsync(
          this.scope.sessionId,
          this.scope.storePath,
          this.scope.sessionFile,
          this.scope.agentId,
        );
    for (const archivePath of candidates) {
      let filePath: string;
      try {
        filePath = materializeSessionArchiveForRead(archivePath);
      } catch {
        // Try the next valid retained generation.
        continue;
      }
      const index = await readSessionTranscriptIndex(filePath, this.scope.sessionId);
      if (!index) {
        continue;
      }
      displaySource ??= index.displaySource;
      const anchorIndex = index.entries.findIndex((entry) => entry.id === opts.messageId);
      if (anchorIndex < 0) {
        continue;
      }
      const range = resolveHistoryAnchorPageRange(index.entries.length, anchorIndex, opts);
      const entries = await readIndexedTranscriptEntries(
        filePath,
        index,
        index.entries.slice(range.readStart, range.endExclusive),
        this.scope.sessionId,
      );
      return {
        displaySource: index.displaySource,
        found: true,
        hasOverreadContext: range.hasOverreadContext,
        messages: entries.flatMap(indexedTranscriptEntryToMessages),
        offset: range.offset,
        totalMessages: index.entries.length,
        transcriptPath: filePath,
        transcriptSource: "reset-archive",
      };
    }
    return {
      displaySource,
      found: false,
      hasOverreadContext: false,
      messages: [],
      offset: 0,
      totalMessages: 0,
    };
  }
}

function indexedTranscriptEntryToMessage(entry: MaterializedTranscriptEntry): unknown {
  return projectTranscriptEntryMessage(entry.record, entry.seq, entry.transcriptPosition);
}

function indexedTranscriptEntryToMessages(entry: MaterializedTranscriptEntry): unknown[] {
  const message = indexedTranscriptEntryToMessage(entry);
  return message ? [message] : [];
}
