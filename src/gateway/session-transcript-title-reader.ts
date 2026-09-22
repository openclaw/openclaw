// Session-list title reads: bounded transcript probes plus a watermark-validated
// cache so list rendering never rescans transcripts that have not changed.
import {
  isSessionTranscriptProjectionUnavailableError,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptWatermark,
  type SessionTranscriptMessageEvent,
  type SessionTranscriptReadScope,
  type SessionTranscriptReadTarget,
} from "../config/sessions/session-accessor.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { projectSessionDisplayMessage } from "./session-display-projection.js";
import { sqliteMessageEventWithSeq } from "./session-transcript-entry-message.js";
import { toTranscriptReadScope } from "./session-transcript-read-target.js";

type SessionTitleFields = {
  firstUserMessage: string | null;
  lastMessagePreview: string | null;
};

const EMPTY_SESSION_TITLE_FIELDS: SessionTitleFields = {
  firstUserMessage: null,
  lastMessagePreview: null,
};
// Session-list title probes must not scale with transcript size. Read at most
// this many active-path messages from either end, widening only once.
const SQLITE_TITLE_PROBE_INITIAL_MESSAGES = 20;
const SQLITE_TITLE_PROBE_MAX_MESSAGES = 100;
const SQLITE_TITLE_FIELD_CACHE_MAX_ENTRIES = 256;

type SqliteTitleFieldCacheEntry = ReturnType<typeof readSessionTranscriptWatermark> & {
  fields: Partial<Record<"default" | "includeInterSession", SessionTitleFields>>;
};

// Appends advance maxSeq while rewind, fork, and compaction rotate generation. Both tokens must
// match or stale titles can survive transcript replacement. Actively streaming sessions therefore
// miss by design; bounded probes limit that load while this LRU still serves idle rows.
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
): SessionTranscriptMessageEvent[] {
  const end = Math.min(totalMessages, endExclusive);
  const boundedStart = Math.min(Math.max(0, start), end);
  if (boundedStart === end) {
    return [];
  }
  return readSessionTranscriptMessageEventPage(scope, {
    maxMessages: end - boundedStart,
    offset: totalMessages - end,
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

function copySessionTitleText(text: string | null): string | null {
  // V8 slices can pin whole transcript payloads behind a short cached preview.
  // Copy UTF-16 code units so ownership changes without altering lone surrogates.
  return text === null ? null : Buffer.from(text, "utf16le").toString("utf16le");
}

function hydrateSqliteTitleFields(
  target: SessionTranscriptReadTarget,
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  try {
    const scope = toTranscriptReadScope(target);
    const cacheKey = sqliteTitleFieldCacheKey(target);
    const watermark = readSessionTranscriptWatermark(scope);
    if (watermark.maxSeq === null) {
      return { ...EMPTY_SESSION_TITLE_FIELDS };
    }
    const variant = opts?.includeInterSession === true ? "includeInterSession" : "default";
    const cached = sqliteTitleFieldCache.get(cacheKey);
    const current =
      cached?.generation === watermark.generation && cached.maxSeq === watermark.maxSeq;
    const cachedFields = current ? cached.fields[variant] : undefined;
    if (cached && cachedFields) {
      setSqliteTitleFieldCache(cacheKey, cached);
      return { ...cachedFields };
    }
    const tail = readSessionTranscriptMessageEventPage(scope, {
      maxMessages: SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
      offset: 0,
    });
    let lastText = findLastMessageText(tail.events);
    if (!lastText && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
      lastText = findLastMessageText(
        readSqliteTitleProbeRange(
          scope,
          tail.totalMessages,
          tail.totalMessages - SQLITE_TITLE_PROBE_MAX_MESSAGES,
          tail.totalMessages - SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
        ),
      );
    }
    const head =
      tail.totalMessages <= SQLITE_TITLE_PROBE_INITIAL_MESSAGES
        ? tail.events
        : readSqliteTitleProbeRange(
            scope,
            tail.totalMessages,
            0,
            SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
          );
    let firstText = findFirstTitleUserText(head, opts?.includeInterSession === true);
    if (!firstText && tail.totalMessages > SQLITE_TITLE_PROBE_INITIAL_MESSAGES) {
      firstText = findFirstTitleUserText(
        readSqliteTitleProbeRange(
          scope,
          tail.totalMessages,
          SQLITE_TITLE_PROBE_INITIAL_MESSAGES,
          SQLITE_TITLE_PROBE_MAX_MESSAGES,
        ),
        opts?.includeInterSession === true,
      );
    }
    const fields = {
      firstUserMessage: copySessionTitleText(firstText),
      lastMessagePreview: copySessionTitleText(lastText),
    };
    const fieldsByVariant = current ? cached.fields : {};
    fieldsByVariant[variant] = fields;
    // Retain only the watermark and bounded strings, never the probe's transcript payloads.
    setSqliteTitleFieldCache(cacheKey, {
      generation: watermark.generation,
      maxSeq: watermark.maxSeq,
      fields: fieldsByVariant,
    });
    return { ...fields };
  } catch (error) {
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
  opts?: { includeInterSession?: boolean },
): SessionTitleFields {
  return hydrateSqliteTitleFields(resolveSessionTranscriptReadTarget(scope), opts);
}
