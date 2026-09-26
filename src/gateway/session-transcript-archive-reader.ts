// Reads transcript artifacts; live store acquisition stays with the caller.
import fs from "node:fs";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { materializeSessionArchiveForRead } from "../config/sessions/archive-compression.js";
import type { TranscriptEvent } from "../config/sessions/session-accessor.js";
import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  resolveHistoryAnchorPageRange,
  resolveTranscriptPageEnd,
  type TranscriptAnchorPageOptions,
  type TranscriptRecentReadLimits,
} from "../sessions/transcript-anchor-page.js";
import { isVisibleTranscriptRecord } from "../sessions/transcript-visible-record.js";
import { projectTranscriptEntryMessage } from "./session-transcript-entry-message.js";
import {
  resolveSessionTranscriptCandidates,
  resolveSessionTranscriptResetArchiveCandidatesAsync,
} from "./session-transcript-files.fs.js";
import {
  assertArchiveTranscriptSource,
  readIndexedTranscriptEntries,
  readSessionTranscriptIndex,
  selectArchiveTranscriptEntries,
  type MaterializedTranscriptEntry,
  type SessionTranscriptIndex,
} from "./session-transcript-index.fs.js";
import {
  MAX_TRANSCRIPT_PARSE_LINE_BYTES,
  parseTranscriptRecord,
} from "./session-transcript-record-parser.js";

export type ReadRecentSessionMessagesOptions = {
  maxMessages: number;
  maxBytes?: number;
  maxLines?: number;
};

type ReadSessionMessagesPageOptions = {
  offset: number;
  maxMessages: number;
  beforeSeq?: number;
  recentAtHead?: TranscriptRecentReadLimits;
};

export type ReadSessionMessagesAsyncOptions =
  | {
      mode: "full";
      reason: string;
    }
  | ({
      mode: "recent";
    } & ReadRecentSessionMessagesOptions);

type ReadRecentSessionMessagesResult = {
  displaySource?: string;
  messages: unknown[];
  totalMessages: number;
  /** Raw selected transcript rows parsed from the same read as `messages`. */
  transcriptEvents?: TranscriptEvent[];
  transcriptPath?: string;
  transcriptSource?: "reset-archive";
};

type ReadSessionMessagesResult = {
  messages: unknown[];
  transcriptPath?: string;
};

const RECENT_SESSION_MESSAGES_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

type ArchivedTranscriptReadScope = {
  agentId?: string | undefined;
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

export function findExistingTranscriptPath(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  return (
    resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId).find((value) =>
      fs.existsSync(value),
    ) ?? null
  );
}

/** Reads retained reset archives after the caller has selected its SQLite fallback. */
export class ArchivedTranscriptReader {
  constructor(private readonly scope: ArchivedTranscriptReadScope) {}

  private async resolvePath(): Promise<string | null> {
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

  async read(opts: ReadSessionMessagesAsyncOptions): Promise<ReadSessionMessagesResult> {
    if (opts.mode === "recent") {
      const snapshot = await this.readRecentWithStats(opts);
      return { messages: snapshot.messages, transcriptPath: snapshot.transcriptPath };
    }
    const filePath = await this.resolvePath();
    if (!filePath) {
      return { messages: [] };
    }
    const index = await readSessionTranscriptIndex(filePath, this.scope.sessionId);
    return {
      messages: index
        ? (
            await readIndexedTranscriptEntries(filePath, index, index.entries, this.scope.sessionId)
          ).flatMap(indexedTranscriptEntryToMessages)
        : [],
      transcriptPath: filePath,
    };
  }

  async readById(
    messageId: string,
  ): Promise<{ message?: unknown; seq?: number; oversized: boolean; found: boolean }> {
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
    if (
      entry.byteLength > MAX_TRANSCRIPT_PARSE_LINE_BYTES &&
      (entry.recoveredImageData !== true ||
        jsonUtf8Bytes(entry.record) > MAX_TRANSCRIPT_PARSE_LINE_BYTES)
    ) {
      return { oversized: true, found: true, seq: entry.seq };
    }
    return {
      message: indexedTranscriptEntryToMessage(entry),
      seq: entry.seq,
      oversized: false,
      found: true,
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
    for (const archivePath of await resolveSessionTranscriptResetArchiveCandidatesAsync(
      this.scope.sessionId,
      this.scope.storePath,
      this.scope.sessionFile,
      this.scope.agentId,
    )) {
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
