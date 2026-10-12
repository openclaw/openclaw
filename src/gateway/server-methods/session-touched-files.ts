import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { withSessionTranscriptDeltaReader } from "../../config/sessions/session-transcript-delta-read.js";
import { LruCache } from "../../infra/lru-cache.js";
import { sqliteMessageEventWithSeq } from "../session-transcript-entry-message.js";
import type { SessionTranscriptReadScope } from "../session-transcript-readers.js";
import type { TouchedFile } from "./workspace-files.js";

type TouchedFilesCacheEntry = {
  cursor: string;
  files: Map<string, TouchedFile>;
};

// Control UI requests fan out per visible session; keep enough folds to avoid
// eviction and full-transcript reparsing across realistic concurrent viewers.
const TOUCHED_FILES_CACHE_LIMIT = 256;
const TOUCHED_FILES_DELTA_MAX_MESSAGES = 1_000;
const TOUCHED_FILES_DELTA_MAX_BYTES = 1_000_000;
// Request latency must not scale with transcript size: delta resets rebuild the
// fold, while this process-local LRU cap bounds retained session state.
const touchedFilesCache = new LruCache<TouchedFilesCacheEntry>(TOUCHED_FILES_CACHE_LIMIT);
// Page yields let other requests interleave, so singleflight keeps one cache-mutating fold per key.
const touchedFilesFolds = new Map<string, Promise<Map<string, TouchedFile>>>();

function readPathArg(args: Record<string, unknown>): string | undefined {
  return (
    normalizeOptionalString(args.path) ??
    normalizeOptionalString(args.file_path) ??
    normalizeOptionalString(args.filePath) ??
    normalizeOptionalString(args.file)
  );
}

function addTouchedFile(
  files: Map<string, TouchedFile>,
  filePath: string | undefined,
  kind: TouchedFile["kind"],
) {
  if (!filePath) {
    return;
  }
  const existing = files.get(filePath);
  if (existing?.kind === "modified" || (existing && kind === "read")) {
    return;
  }
  files.set(filePath, { path: filePath, kind });
}

function addRawPatchFiles(files: Map<string, TouchedFile>, input: unknown) {
  if (typeof input !== "string") {
    return;
  }
  const fileLinePattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  for (const match of input.matchAll(fileLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
  const moveLinePattern = /^\*\*\* Move to: (.+)$/gm;
  for (const match of input.matchAll(moveLinePattern)) {
    addTouchedFile(files, match[1]?.trim(), "modified");
  }
}

function addStructuredPatchFiles(files: Map<string, TouchedFile>, changes: unknown) {
  if (!Array.isArray(changes)) {
    return;
  }
  for (const changeValue of changes) {
    const change = asOptionalObjectRecord(changeValue);
    addTouchedFile(files, normalizeOptionalString(change?.path), "modified");
    const kind = asOptionalObjectRecord(change?.kind);
    addTouchedFile(
      files,
      normalizeOptionalString(kind?.move_path) ?? normalizeOptionalString(kind?.movePath),
      "modified",
    );
  }
}

function collectTouchedFilesFromMessage(message: unknown, files: Map<string, TouchedFile>) {
  const record = asOptionalObjectRecord(message);
  if (record?.role !== "assistant" || !Array.isArray(record.content)) {
    return;
  }
  for (const blockValue of record.content) {
    const block = asOptionalObjectRecord(blockValue);
    if (!block || typeof block.type !== "string") {
      continue;
    }
    const type = block.type.toLowerCase().replace(/[_-]/g, "");
    if (type !== "toolcall" && type !== "tooluse") {
      continue;
    }
    const toolName = normalizeOptionalString(block.name)?.toLowerCase();
    const args =
      asOptionalObjectRecord(block.arguments) ??
      asOptionalObjectRecord(block.input) ??
      asOptionalObjectRecord(block.args);
    if (!toolName || !args) {
      continue;
    }
    if (toolName === "read") {
      addTouchedFile(files, readPathArg(args), "read");
    } else if (toolName === "write" || toolName === "edit") {
      addTouchedFile(files, readPathArg(args), "modified");
    } else if (toolName === "apply_patch") {
      addRawPatchFiles(files, args.input);
      addStructuredPatchFiles(files, args.changes);
    }
  }
}

async function foldSqliteTouchedFiles(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<Map<string, TouchedFile>> {
  return withSessionTranscriptDeltaReader(scope, async (reader) => {
    const cached = touchedFilesCache.get(cacheKey);
    let cursor = cached?.cursor;
    let files = cached?.files ?? new Map<string, TouchedFile>();
    let maxBytes = TOUCHED_FILES_DELTA_MAX_BYTES;

    while (true) {
      const delta = await reader.visible({
        ...(cursor ? { cursor } : {}),
        maxBytes,
        maxMessages: TOUCHED_FILES_DELTA_MAX_MESSAGES,
      });
      if (delta.kind === "missing") {
        touchedFilesCache.delete(cacheKey);
        return new Map();
      }
      if (delta.kind === "reset") {
        cursor = delta.cursor;
        files = new Map();
        touchedFilesCache.set(cacheKey, { cursor, files });
        continue;
      }
      for (const event of delta.events) {
        const message = sqliteMessageEventWithSeq(event);
        if (message !== undefined) {
          collectTouchedFilesFromMessage(message, files);
        }
      }
      cursor = delta.cursor;
      touchedFilesCache.set(cacheKey, { cursor, files });
      if (!delta.hasMore) {
        return files;
      }
      if (delta.requiredBytes !== undefined) {
        maxBytes = delta.requiredBytes;
      }
      await nextTurn();
    }
  });
}

export async function loadSessionTouchedFiles(
  scope: SessionTranscriptReadScope,
  cacheKey: string,
): Promise<Map<string, TouchedFile>> {
  const inFlight = touchedFilesFolds.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const fold = foldSqliteTouchedFiles(scope, cacheKey);
  touchedFilesFolds.set(cacheKey, fold);
  try {
    return await fold;
  } finally {
    touchedFilesFolds.delete(cacheKey);
  }
}
