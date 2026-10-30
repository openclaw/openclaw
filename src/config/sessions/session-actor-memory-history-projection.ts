import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { projectTranscriptEntryMessage } from "../../gateway/session-transcript-entry-message.js";
import type {
  SessionTranscriptProjectionSelection,
  SessionTranscriptProjectionSelectionResults,
  SessionTranscriptSourceCursor,
} from "../../gateway/session-transcript-read.types.js";
import {
  assertUnboundedAnchorPageUsable,
  SessionTranscriptSourceMessageTooLargeError,
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
} from "../../gateway/session-transcript-source-pages.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { readNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import {
  resolveHistoryAnchorPageRange,
  resolveTranscriptPageEnd,
} from "../../sessions/transcript-anchor-page.js";
import {
  createTranscriptDisplayPositionFromActivity,
  createTranscriptDisplaySource,
} from "../../sessions/transcript-display-position.js";
import type {
  TranscriptReadWindow,
  TranscriptReadWindowOptions,
} from "../../sessions/transcript-read-window.js";
import { isVisibleTranscriptRecord } from "../../sessions/transcript-visible-record.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
} from "./session-accessor.types.js";
import { readSessionActorMemoryBoundedTail } from "./session-actor-memory-history-facts.js";
import {
  createSessionActorMemoryHistoryNavigation,
  resolveSessionActorMemoryHistoryStart,
  type SessionActorMemoryHistoryRow,
} from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  bootstrapRawTranscriptCursor,
  createTranscriptRawDeltaCursor,
  encodeRawTranscriptCursor,
  normalizeRawDeltaLimits,
  parseRawTranscriptCursor,
} from "./session-transcript-raw-cursor.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { readRecentTranscriptConversationText } from "./transcript-recent-text.js";

export type SessionActorMemoryHistoryScope = {
  agentId: string;
  path: string;
  readFence?: { beforeRawSeq: number; beforeActiveMessagePosition: number };
};

export function readSessionActorMemoryRawDelta(
  window: SessionActorMemoryWindow,
  scope: SessionActorMemoryHistoryScope,
  limits: SessionTranscriptRawDeltaLimits,
): SessionTranscriptRawDeltaResult {
  const { maxBytes, maxEvents } = normalizeRawDeltaLimits(limits);
  const generation = window.hot.transcript.version.generation;
  const sessionId = window.hot.entry?.sessionId;
  if (!generation || !sessionId) {
    return { kind: "missing" };
  }
  const initial = bootstrapRawTranscriptCursor({ agentId: scope.agentId, sessionId }, generation);
  const reset = (
    reason: Extract<SessionTranscriptRawDeltaResult, { kind: "reset" }>["reason"],
  ): SessionTranscriptRawDeltaResult => ({
    kind: "reset",
    cursor: encodeRawTranscriptCursor(initial),
    reason,
  });
  const cursor = limits.cursor === undefined ? initial : parseRawTranscriptCursor(limits.cursor);
  if (!cursor) {
    return reset("invalid_cursor");
  }
  if (cursor.agentId !== scope.agentId || cursor.sessionId !== sessionId) {
    return reset("scope_mismatch");
  }
  if (cursor.generation !== generation) {
    return reset("generation_mismatch");
  }
  if (cursor.lastSeq > (window.events.at(-1)?.rawSeq ?? -1)) {
    if (scope.readFence) {
      throw new SessionTranscriptReadFenceError(
        "Transcript read cursor has crossed the current-turn admission fence",
      );
    }
    return reset("invalid_cursor");
  }
  const events: Extract<SessionTranscriptRawDeltaResult, { kind: "page" }>["events"] = [];
  let serializedBytes = 0;
  let requiredBytes: number | undefined;
  let hasMore = false;
  let lastSeq = cursor.lastSeq;
  for (const row of window.events) {
    if (row.rawSeq <= cursor.lastSeq) {
      continue;
    }
    const bytes = Buffer.byteLength(row.eventJson) + 1;
    if (events.length >= maxEvents || serializedBytes + bytes > maxBytes) {
      hasMore = true;
      if (!events.length) {
        requiredBytes = bytes;
      }
      break;
    }
    serializedBytes += bytes;
    lastSeq = row.rawSeq;
    events.push({ event: row.event, seq: row.rawSeq });
  }
  return {
    kind: "page",
    cursor: encodeRawTranscriptCursor({ ...cursor, lastSeq }),
    events,
    hasMore,
    serializedBytes,
    ...(requiredBytes === undefined ? {} : { requiredBytes }),
  };
}

/** History readers borrow rows and materialize only the selected response. */
export function readSessionActorMemoryProjection(
  window: SessionActorMemoryWindow,
  scope: SessionActorMemoryHistoryScope,
  selection: SessionTranscriptProjectionSelection,
): SessionTranscriptProjectionSelectionResults[SessionTranscriptProjectionSelection["kind"]] {
  const navigation = createSessionActorMemoryHistoryNavigation(window);
  const { visibleHistory: history, active, tree } = navigation;
  const sessionId = window.hot.entry?.sessionId ?? "";
  const generation = window.hot.transcript.version.generation;
  const displaySource = generation
    ? createTranscriptDisplaySource(["memory", scope.path, scope.agentId, sessionId, generation])
    : undefined;
  const position = (row: { event: unknown; rawSeq: number }) =>
    displaySource
      ? createTranscriptDisplayPositionFromActivity(
          displaySource,
          row.rawSeq,
          readNestedToolActivity(isRecord(row.event) ? row.event.message : undefined)?.details,
          (id) => {
            const node = tree.byId.get(id);
            return node ? window.events[node.index]?.rawSeq : undefined;
          },
        )
      : undefined;
  const message = (row: SessionActorMemoryHistoryRow, seq: number) =>
    projectTranscriptEntryMessage(row.event, seq, position(row));
  const messages = (rows: SessionActorMemoryHistoryRow[], offset: number) =>
    rows.map((row, index) => message(row, offset + index + 1)).filter((value) => value !== null);
  const deltaCursor = generation
    ? createTranscriptRawDeltaCursor({
        agentId: scope.agentId,
        sessionId,
        generation,
        lastSeq: window.events.at(-1)?.rawSeq ?? -1,
      })
    : undefined;
  const capture = (rows: SessionActorMemoryHistoryRow[], offset: number): TranscriptReadWindow => ({
    source: displaySource,
    latestResetRawSeq: navigation.latestResetRawSeq,
    ...(rows.at(-1) ? { anchor: { rawSeq: rows.at(-1)!.rawSeq, seq: offset + rows.length } } : {}),
  });
  const change = (
    expected: TranscriptReadWindow | undefined,
  ): { anchorSeq?: number } | undefined => {
    if (!expected) {
      return undefined;
    }
    if (expected.source !== displaySource) {
      return {};
    }
    if (!expected.anchor) {
      return expected.latestResetRawSeq === navigation.latestResetRawSeq ? undefined : {};
    }
    const index = history.findIndex((row) => row.rawSeq === expected.anchor!.rawSeq);
    const seq = index < 0 ? undefined : index + 1;
    return seq === expected.anchor.seq &&
      expected.latestResetRawSeq === navigation.latestResetRawSeq
      ? undefined
      : { anchorSeq: seq };
  };
  const recent = (
    options: {
      maxMessages: number;
      maxBytes?: number;
      maxLines?: number;
    } & TranscriptReadWindowOptions,
  ) => {
    const maxMessages = resolveIntegerOption(options.maxMessages, 0, { min: 0, max: 10_000 });
    const maxLines = resolveIntegerOption(options.maxLines, maxMessages * 20 + 20, { min: 0 });
    const changed = change(options.expectedReadWindow);
    const start =
      !maxMessages || !maxLines
        ? history.length
        : resolveSessionActorMemoryHistoryStart(
            history,
            Math.max(0, history.length - maxLines),
            history.length,
            Math.min(
              resolveIntegerOption(options.maxBytes, SOURCE_PAGE_MAX_BYTES, { min: 1024 }),
              SOURCE_PAGE_MAX_BYTES,
            ),
            maxMessages,
            true,
          );
    const rows = history.slice(start);
    return {
      messages: messages(rows, start),
      totalMessages: history.length,
      activeLeafEntryId: tree.leafId,
      displaySource,
      ...(deltaCursor ? { deltaCursor } : {}),
      ...(options.captureReadWindow || changed ? { readWindow: capture(rows, start) } : {}),
      ...(changed ? { windowReset: true } : {}),
      transcriptPath: window.hot.target.sessionKey,
      transcriptSource: "active" as const,
    };
  };
  const readPage = (
    inputOptions: Extract<SessionTranscriptProjectionSelection, { kind: "page" }>["options"],
  ) => {
    let options = inputOptions;
    const changed = change(options.expectedReadWindow);
    if (changed) {
      options = {
        ...options,
        captureReadWindow: true,
        expectedReadWindow: undefined,
        ...(changed.anchorSeq !== undefined && options.expectedReadWindow?.anchor
          ? {
              beforeSeq:
                options.beforeSeq === undefined
                  ? undefined
                  : options.beforeSeq + changed.anchorSeq - options.expectedReadWindow.anchor.seq,
            }
          : { beforeSeq: undefined, offset: 0 }),
      };
    }
    const end = resolveTranscriptPageEnd(history.length, options);
    if (options.recentAtHead && end === history.length) {
      return {
        ...recent({ ...options.recentAtHead, captureReadWindow: options.captureReadWindow }),
        ...(changed ? { windowReset: true } : {}),
      };
    }
    const maxMessages = resolveIntegerOption(options.maxMessages, 0, { min: 0 });
    const requestedStart = Math.max(0, end - maxMessages);
    const start = resolveSessionActorMemoryHistoryStart(
      history,
      requestedStart,
      end,
      resolveIntegerOption(options.maxBytes, SOURCE_PAGE_MAX_BYTES, { min: 1024 }),
      maxMessages,
      options.allowOversizedFirst ?? options.maxBytes === undefined,
      0,
      options.maxBytes === undefined,
    );
    const omittedOversized = maxMessages > 0 && end > 0 && start === end;
    const consumedStart = omittedOversized ? end - 1 : start;
    const rows = history.slice(start, end);
    return {
      messages: messages(rows, start),
      totalMessages: history.length,
      activeLeafEntryId: tree.leafId,
      displaySource,
      transcriptPath: window.hot.target.sessionKey,
      transcriptSource: "active" as const,
      ...(options.maxBytes !== undefined && maxMessages > 0 && consumedStart > 0
        ? {
            olderOffset:
              resolveTranscriptPageEnd(history.length, { beforeSeq: options.beforeSeq }) -
              consumedStart,
          }
        : {}),
      ...(omittedOversized ? { omittedOversized: true } : {}),
      ...(options.captureReadWindow ? { readWindow: capture(rows, start) } : {}),
      ...(changed ? { windowReset: true } : {}),
    };
  };
  const closedHistory = (row: SessionActorMemoryHistoryRow) => {
    const close = active.find(
      (candidate) =>
        candidate.activePosition >= row.activePosition &&
        isRecord(candidate.event) &&
        candidate.event.type === "reset",
    );
    if (!close) {
      return undefined;
    }
    const previous = active.findLast(
      (candidate) =>
        candidate.activePosition < close.activePosition &&
        isRecord(candidate.event) &&
        candidate.event.type === "reset",
    );
    return active.filter(
      (candidate) =>
        candidate.activePosition > (previous?.activePosition ?? -1) &&
        candidate.activePosition <= close.activePosition &&
        isVisibleTranscriptRecord(candidate.event),
    );
  };
  const find = (id: string) =>
    active.find(
      (row) => isRecord(row.event) && row.event.id === id && isVisibleTranscriptRecord(row.event),
    );
  switch (selection.kind) {
    case "recent-text":
      return readRecentTranscriptConversationText(
        (page) => readSessionActorMemoryBoundedTail(window, navigation, page),
        selection.options,
      );
    case "count":
      return history.length;
    case "delta": {
      const result = readSessionActorMemoryRawDelta(window, scope, selection.options);
      if (result.kind !== "page") {
        return result;
      }
      const sequences = new Map(history.map((row, index) => [row.rawSeq, index + 1]));
      return {
        ...result,
        activeLeafEntryId: tree.leafId,
        events: result.events.map((row) =>
          Object.assign({}, row, {
            ...(sequences.has(row.seq) ? { messageSeq: sequences.get(row.seq) } : {}),
            displayPosition: position({ event: row.event, rawSeq: row.seq }),
          }),
        ),
      };
    }
    case "recent":
      return recent(selection.options);
    case "page":
      return readPage(selection.options);
    case "by-id": {
      const row = find(selection.messageId);
      if (!row) {
        return { found: false, oversized: false };
      }
      const currentIndex = history.indexOf(row);
      const rows =
        currentIndex < 0
          ? selection.options?.currentOnly
            ? undefined
            : closedHistory(row)
          : history;
      const index = rows?.indexOf(row) ?? -1;
      if (index < 0 || !rows) {
        return { found: false, oversized: false };
      }
      if (
        selection.options?.maxBytes !== undefined &&
        row.serializedBytes - 1 > selection.options.maxBytes
      ) {
        return {
          found: true,
          oversized: true,
          seq: index + 1,
          serializedBytes: row.serializedBytes - 1,
        };
      }
      return {
        found: true,
        oversized: false,
        message: message(row, index + 1),
        seq: index + 1,
        ...(selection.options?.maxBytes !== undefined
          ? { serializedBytes: row.serializedBytes - 1 }
          : {}),
        ...(selection.options?.historyVisibility
          ? {
              historyContext: {
                displaySource,
                ...(index > 0 ? { precedingMessage: message(rows[index - 1]!, index) } : {}),
              },
            }
          : {}),
      };
    }
    case "lookup":
      return {
        hasDisplayMessages: history.some((row) => isVisibleTranscriptRecord(row.event)),
        messages: history.flatMap((row, index) => {
          const value = message(row, index + 1);
          return isRecord(value) &&
            isRecord(value["__openclaw"]) &&
            value["__openclaw"].id === selection.messageId
            ? [value]
            : [];
        }),
      };
    case "around-id": {
      const options = selection.options;
      const row = find(options.messageId);
      const changed = change(options.expectedReadWindow);
      if (changed && (!row || !history.includes(row))) {
        return {
          ...readPage({
            offset: 0,
            maxMessages: options.maxMessages,
            maxBytes: Math.min(options.maxBytes ?? SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_BYTES),
            captureReadWindow: true,
          }),
          windowReset: true,
          found: true,
          hasOverreadContext: false,
          offset: 0,
        };
      }
      if (!row) {
        return {
          found: false,
          messages: [],
          totalMessages: history.length,
          hasOverreadContext: false,
          offset: 0,
        };
      }
      const closed =
        options.closedResetInterval === true &&
        options.direction === "older" &&
        isRecord(row.event) &&
        row.event.type === "reset";
      let rows = closed || !history.includes(row) ? closedHistory(row) : history;
      if (!rows) {
        return {
          found: false,
          messages: [],
          totalMessages: history.length,
          hasOverreadContext: false,
          offset: 0,
        };
      }
      let anchor = rows.indexOf(row);
      if (closed) {
        rows = rows.slice(0, anchor);
        anchor = rows.length - 1;
      }
      const range = resolveHistoryAnchorPageRange(rows.length, anchor, options);
      const limit = Math.min(options.maxBytes ?? SOURCE_PAGE_MAX_BYTES, SOURCE_PAGE_MAX_BYTES);
      const start = resolveSessionActorMemoryHistoryStart(
        rows,
        range.readStart,
        range.endExclusive,
        Math.max(1024, Math.floor(limit)),
        Infinity,
        options.maxBytes === undefined,
        2,
      );
      assertUnboundedAnchorPageUsable(options, { start, ...range });
      let selected = rows.slice(start, range.endExclusive);
      let selectedStart = start;
      if (options.maxBytes !== undefined) {
        const responseLimit = Math.max(1024, Math.floor(limit));
        let bytes = 2;
        let index = selected.length;
        while (index > 0) {
          const candidate = selected[index - 1]!;
          const size = jsonUtf8Bytes({
            event: candidate.event,
            eventSeq: candidate.rawSeq,
            seq: start + index,
            displayPosition: position(candidate),
          });
          const separator = index === selected.length ? 0 : 1;
          if (bytes + size + separator > responseLimit) {
            break;
          }
          bytes += size + separator;
          index--;
        }
        selectedStart += index;
        selected = selected.slice(index);
      }
      return {
        found: true,
        messages: messages(selected, selectedStart),
        totalMessages: rows.length,
        hasOverreadContext: range.hasOverreadContext && selectedStart === range.readStart,
        offset: range.offset,
        displaySource,
        transcriptPath: window.hot.target.sessionKey,
        ...(changed ? { windowReset: true, readWindow: capture(selected, selectedStart) } : {}),
      };
    }
    case "source": {
      const options = selection.options;
      const messageIds = options.messageIds && new Set(options.messageIds);
      if (options.cursor?.kind === "archive") {
        throw new Error("Memory sessions have no archive source");
      }
      const count = options.cursor?.snapshot.activeEventCount ?? active.length;
      const tail = active[count - 1]?.rawSeq;
      const snapshot = options.cursor?.snapshot ?? {
        indexedSeq: window.events.at(-1)?.rawSeq ?? -1,
        activeEventCount: count,
        totalMessages: history.length,
        generation: generation ?? undefined,
        tailEventSeq: tail,
        resetSeq: navigation.latestResetRawSeq,
      };
      if (
        options.cursor &&
        (snapshot.generation !== (generation ?? undefined) ||
          snapshot.indexedSeq > (window.events.at(-1)?.rawSeq ?? -1) ||
          snapshot.tailEventSeq !== tail ||
          snapshot.resetSeq !== navigation.latestResetRawSeq)
      ) {
        throw new SessionTranscriptProjectionUnavailableError(sessionId, "window-changed");
      }
      if (!options.cursor && snapshot.totalMessages === 0) {
        return {
          messages: [],
          snapshot,
          ...(options.includeOffPathMessages
            ? { nextCursor: { kind: "off-path" as const, position: -1, messageSeq: 0, snapshot } }
            : {}),
        };
      }
      let cursor: Exclude<SessionTranscriptSourceCursor, { kind: "archive" }> | undefined =
        options.cursor ?? {
          kind: navigation.keptMessages.length ? "kept" : "active",
          position: navigation.keptMessages.length ? 0 : (navigation.boundaryActivePosition ?? 0),
          messageSeq: 0,
          snapshot,
        };
      const output: unknown[] = [];
      let bytes = 0;
      let consumed = 0;
      const activeSeqs = new Set(active.slice(0, count).map((row) => row.rawSeq));
      let rawPosition = 0;
      while (cursor && consumed < SOURCE_PAGE_MAX_MESSAGES) {
        if (cursor.kind === "off-path") {
          while (
            rawPosition < window.events.length &&
            (window.events[rawPosition]!.rawSeq <= cursor.position ||
              activeSeqs.has(window.events[rawPosition]!.rawSeq))
          ) {
            rawPosition++;
          }
        }
        const row =
          cursor.kind === "kept"
            ? navigation.keptMessages[cursor.position]
            : cursor.kind === "active"
              ? active[cursor.position < count ? cursor.position : -1]
              : (window.events[rawPosition]?.rawSeq ?? Infinity) <= snapshot.indexedSeq
                ? window.events[rawPosition]
                : undefined;
        if (!row) {
          cursor =
            cursor.kind === "kept"
              ? { ...cursor, kind: "active", position: navigation.boundaryActivePosition ?? 0 }
              : cursor.kind === "active" && options.includeOffPathMessages
                ? { ...cursor, kind: "off-path", position: -1 }
                : undefined;
          continue;
        }
        if (messageIds) {
          const event = isRecord(row.event) ? row.event : undefined;
          const storedMessage = isRecord(event?.message) ? event.message : undefined;
          const storedMeta = isRecord(storedMessage?.["__openclaw"])
            ? storedMessage["__openclaw"]
            : undefined;
          const messageId = typeof event?.id === "string" ? event.id : storedMeta?.id;
          if (typeof messageId !== "string" || !messageIds.has(messageId)) {
            cursor = {
              ...cursor,
              position: cursor.kind === "off-path" ? row.rawSeq : cursor.position + 1,
              messageSeq:
                cursor.messageSeq +
                (cursor.kind !== "off-path" && isVisibleTranscriptRecord(row.event) ? 1 : 0),
            };
            continue;
          }
        }
        const size = Buffer.byteLength(row.eventJson) + 1;
        if (size > SOURCE_PAGE_MAX_BYTES) {
          throw new SessionTranscriptSourceMessageTooLargeError();
        }
        if (bytes + size > SOURCE_PAGE_MAX_BYTES) {
          break;
        }
        bytes += size;
        consumed++;
        if (isVisibleTranscriptRecord(row.event)) {
          const seq = cursor.kind === "off-path" ? row.rawSeq + 1 : cursor.messageSeq + 1;
          if (cursor.kind !== "off-path") {
            cursor = { ...cursor, messageSeq: seq };
          }
          const value = projectTranscriptEntryMessage(
            row.event,
            seq,
            cursor.kind === "off-path" ? undefined : position(row),
          );
          if (value !== null) {
            output.push(value);
          }
        }
        cursor = {
          ...cursor,
          position: cursor.kind === "off-path" ? row.rawSeq : cursor.position + 1,
        };
      }
      return {
        messages: output,
        snapshot,
        transcriptPath: window.hot.target.sessionKey,
        ...(cursor ? { nextCursor: cursor } : {}),
      };
    }
  }
  throw new Error("Unknown memory history projection");
}
