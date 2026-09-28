// Session-list title reads: bounded transcript probes plus a watermark-validated
// cache so list rendering never rescans transcripts that have not changed.
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptWatermark,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
  type SessionTranscriptReadTarget,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "../config/sessions/session-accessor.transcript-read-target.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";
import { toTranscriptReadScope } from "./session-transcript-read-target.js";
import type { SessionTitleFields } from "./session-utils.types.js";

type SessionTitleReadOptions = { includeInterSession?: boolean; readOnly?: boolean };

const EMPTY_SESSION_TITLE_FIELDS: SessionTitleFields = {
  firstUserMessage: null,
  lastMessagePreview: null,
};
// Session-list title probes must not scale with transcript size. Read at most
// this many active-path messages from either end, widening only once.
const SQLITE_TITLE_PROBE_INITIAL_MESSAGES = 20;
const SQLITE_TITLE_PROBE_MAX_MESSAGES = 100;
const SQLITE_TITLE_TAIL_PROBE_MAX_BYTES = 64 * 1024;
// Hold a several-thousand-session working set with headroom; entries retain only tokens and bounded text.
const SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES = 8192;

type SqliteTitleFieldCacheEntry = ReturnType<typeof readSessionTranscriptWatermark> & {
  boundarySeq?: number;
  totalMessages: number;
  firstUserMessages: Partial<
    Record<"default" | "includeInterSession", { text: string | null; scannedMessages: number }>
  >;
  lastMessagePreview: string | null;
};

// Found titles survive appends only while the rewrite generation and visible reset window stay fixed.
const sqliteTitleFieldCache = new Map<string, SqliteTitleFieldCacheEntry>();

function sqliteTitleFieldCacheKey(target: SessionTranscriptReadTarget): string {
  return `${target.agentId ?? ""}\0${target.sessionId}\0${target.storePath ?? ""}`;
}

function setSqliteTitleFieldCache(key: string, entry: SqliteTitleFieldCacheEntry): void {
  sqliteTitleFieldCache.delete(key);
  sqliteTitleFieldCache.set(key, entry);
  pruneMapToMaxSize(sqliteTitleFieldCache, SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES);
}

function readSqliteTitleProbeRange(
  scope: SessionTranscriptReadScope,
  totalMessages: number,
  start: number,
  endExclusive: number,
  readOnly?: boolean,
): SessionTranscriptMessageEvent[] {
  const end = Math.min(totalMessages, endExclusive);
  const boundedStart = Math.min(Math.max(0, start), end);
  if (boundedStart === end) {
    return [];
  }
  return readSessionTranscriptMessageEventPage(scope, {
    maxMessages: end - boundedStart,
    offset: boundedStart,
    offsetFrom: "start",
    ...(readOnly ? { readOnly } : {}),
  }).events;
}

function findFirstTitleUserText(
  entries: readonly Parameters<typeof sqliteMessageEventWithSeq>[0][],
  includeInterSession: boolean,
): string | null {
  for (const entry of entries) {
    const message = sqliteMessageEventWithSeq(entry);
    const projected = projectSessionDisplayMessage(message);
    if (
      projected?.role === "user" &&
      (includeInterSession ||
        !hasInterSessionUserProvenance(message as { role?: unknown; provenance?: unknown }))
    ) {
      return projected.text;
    }
  }
  return null;
}

function findLastMessageText(
  entries: readonly Parameters<typeof sqliteMessageEventWithSeq>[0][],
): string | null {
  let text: string | null = null;
  entries.findLast((entry) => {
    const message = sqliteMessageEventWithSeq(entry);
    text = projectSessionDisplayMessage(message, { flattenMarkdown: true })?.text ?? null;
    return text !== null;
  });
  return text;
}

function readSqliteTitleTailProbe(
  scope: SessionTranscriptReadScope,
  maxMessages: number,
  offset: number,
  readOnly?: boolean,
) {
  const page = readSessionTranscriptBoundedMessageTailPage(scope, {
    maxMessages,
    maxBytes: SQLITE_TITLE_TAIL_PROBE_MAX_BYTES,
    offset,
    ...(readOnly ? { readOnly } : {}),
  });
  const newest = page.newestContiguousEventCount
    ? page.events.slice(-page.newestContiguousEventCount)
    : [];
  let text = findLastMessageText(newest);
  if (text === null && page.newestContiguousEventCount < page.scannedMessages) {
    // An omitted message could own the preview. Preserve the existing message-count bound
    // when the byte-bounded suffix alone cannot establish the newest visible text.
    text = findLastMessageText(
      readSessionTranscriptMessageEventPage(scope, {
        maxMessages,
        offset,
        ...(readOnly ? { readOnly } : {}),
      }).events,
    );
  }
  return {
    text,
    totalMessages: page.totalMessages,
    generation: page.snapshot.generation ?? null,
    maxSeq: page.snapshot.indexedSeq,
    boundarySeq: page.snapshot.boundarySeq,
  };
}

function copySessionTitleText(text: string | null): string | null {
  // V8 slices can pin whole transcript payloads behind a short cached preview.
  // Copy UTF-16 code units so ownership changes without altering lone surrogates.
  return text === null ? null : Buffer.from(text, "utf16le").toString("utf16le");
}

function hydrateSqliteTitleFields(
  target: SessionTranscriptReadTarget,
  opts?: SessionTitleReadOptions,
): SessionTitleFields {
  try {
    const scope = toTranscriptReadScope(target);
    const cacheKey = sqliteTitleFieldCacheKey(target);
    const watermark = readSessionTranscriptWatermark(scope);
    if (watermark.maxSeq === null) {
      return { ...EMPTY_SESSION_TITLE_FIELDS };
    }
    const variant = opts?.includeInterSession === true ? "includeInterSession" : "default";
    const entry = sqliteTitleFieldCache.get(cacheKey);
    const cached = entry?.generation === watermark.generation ? entry : undefined;
    const current = cached?.maxSeq === watermark.maxSeq;
    const cachedTitle = cached?.firstUserMessages[variant];
    if (
      cached &&
      current &&
      cachedTitle &&
      (cachedTitle.text !== null ||
        cachedTitle.scannedMessages >=
          Math.min(cached.totalMessages, SQLITE_TITLE_PROBE_MAX_MESSAGES))
    ) {
      setSqliteTitleFieldCache(cacheKey, cached);
      return {
        firstUserMessage: cachedTitle.text,
        lastMessagePreview: cached.lastMessagePreview,
      };
    }
    const tail = current
      ? {
          text: cached.lastMessagePreview,
          totalMessages: cached.totalMessages,
          generation: cached.generation,
          maxSeq: cached.maxSeq,
          boundarySeq: cached.boundarySeq,
        }
      : readSqliteTitleTailProbe(scope, SQLITE_TITLE_PROBE_INITIAL_MESSAGES, 0, opts?.readOnly);
    let lastText = tail.text;
    if (!current && !lastText && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
      lastText = readSqliteTitleTailProbe(
        scope,
        SQLITE_TITLE_PROBE_MAX_MESSAGES - SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
        SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
        opts?.readOnly,
      ).text;
    }
    const firstUserMessages =
      cached?.generation === tail.generation && cached.boundarySeq === tail.boundarySeq
        ? cached.firstUserMessages
        : {};
    const head = firstUserMessages[variant];
    let firstText = head?.text ?? null;
    let scannedMessages = head?.scannedMessages ?? 0;
    // A missing title can appear on append. Inspect only new rows within the bounded head.
    for (const limit of [SQLITE_TITLE_PROBE_INITIAL_MESSAGES, SQLITE_TITLE_PROBE_MAX_MESSAGES]) {
      const end = Math.min(tail.totalMessages, limit);
      if (!firstText && scannedMessages < end) {
        firstText = findFirstTitleUserText(
          readSqliteTitleProbeRange(
            scope,
            tail.totalMessages,
            scannedMessages,
            end,
            opts?.readOnly,
          ),
          opts?.includeInterSession === true,
        );
        scannedMessages = end;
      }
    }
    const fields = {
      firstUserMessage: copySessionTitleText(firstText),
      lastMessagePreview: copySessionTitleText(lastText),
    };
    firstUserMessages[variant] = { text: fields.firstUserMessage, scannedMessages };
    // Retain only the watermark and bounded strings, never the probe's transcript payloads.
    setSqliteTitleFieldCache(cacheKey, {
      generation: tail.generation,
      maxSeq: tail.maxSeq,
      boundarySeq: tail.boundarySeq,
      totalMessages: tail.totalMessages,
      firstUserMessages,
      lastMessagePreview: fields.lastMessagePreview,
    });
    return { ...fields };
  } catch (error) {
    if (opts?.readOnly && isSessionTranscriptProjectionUnavailableError(error)) {
      // A read worker returns this to the host that owns projection reconciliation.
      throw error;
    }
    if (
      !isSessionTranscriptProjectionUnavailableError(error) &&
      !(error instanceof SessionTranscriptColdError)
    ) {
      throw error;
    }
    // Optional titles must not restore cold payloads. Do not cache nulls under the preserved
    // watermark: restoration and projection reconciliation can make these fields available again.
    return { ...EMPTY_SESSION_TITLE_FIELDS };
  }
}

/** Reads title and preview text from one transcript. */
export function readSessionTitleFieldsFromTranscript(
  scope: SessionTranscriptReadScope,
  opts?: SessionTitleReadOptions,
): SessionTitleFields {
  return hydrateSqliteTitleFields(resolveSessionTranscriptReadTarget(scope), opts);
}

/** Reuse the bounded title cache in the existing history worker without transporting session metadata. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  const target = prepareSessionTranscriptReadTargetCore(scope);
  const readScope: SessionTranscriptReadScope = {
    agentId: target.agentId,
    sessionId: scope.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.sessionEntry ? { sessionEntry: { sessionId: scope.sessionEntry.sessionId } } : {}),
  };
  const resolved = resolveSqliteTranscriptReadScope(readScope);
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    return readSessionTitleFieldsFromTranscript(readScope, opts);
  }
  const admission = resolveSessionTranscriptReadFence(resolved);
  const { withSessionHistoryWorkerDatabase } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  try {
    return await withSessionHistoryWorkerDatabase(options, (owner) =>
      owner.readTitleFields({
        scope: { ...readScope, storePath: databasePath },
        ...(opts?.includeInterSession ? { includeInterSession: true } : {}),
        ...(admission ? { admission: { ...admission } } : {}),
      }),
    );
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: resolved.sessionId });
      return { ...EMPTY_SESSION_TITLE_FIELDS };
    }
    throw error;
  }
}
