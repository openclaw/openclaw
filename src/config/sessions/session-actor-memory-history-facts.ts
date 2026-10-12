import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import {
  buildSessionPreviewItems,
  projectSessionDisplayMessage,
} from "../../gateway/session-display-projection.js";
import {
  SOURCE_PAGE_MAX_BYTES,
  SOURCE_PAGE_MAX_MESSAGES,
} from "../../gateway/session-transcript-source-pages.js";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import { NESTED_TOOL_ACTIVITY_CUSTOM_TYPE } from "../../sessions/nested-tool-activity.js";
import { matchesTranscriptEvent } from "../../sessions/transcript-visible-record.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import type {
  SessionTranscriptBoundedMessageTailOptions,
  SessionTranscriptBoundedMessageTailPage,
  SessionTranscriptMessageEvent,
} from "./session-accessor.sqlite-projection-read.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import type {
  SessionActorMemoryHistoryFactsQuery,
  SessionActorMemoryHistoryFactsReads,
} from "./session-actor-memory-history-facts-contract.js";
import {
  createSessionActorMemoryHistoryNavigation,
  type SessionActorMemoryHistoryRow,
} from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { readSessionActorMemoryTranscriptStats } from "./session-actor-memory-usage.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { extractSessionBranchHeadline } from "./session-message-cut-content.js";
import { readSessionTranscriptAccountingTail } from "./session-transcript-accounting-policy.js";
import { SQLITE_USAGE_TAIL_MAX_EVENTS } from "./session-transcript-accounting.types.js";
import type {
  SessionTranscriptMaintenanceFacts,
  SessionTranscriptMaintenanceRead,
} from "./session-transcript-hydration.types.js";
import { transcriptEventContextEligibility } from "./session-transcript-projection-append.js";
import { projectAssistantTranscriptText } from "./transcript-assistant-delivery-read.js";
import {
  selectSessionTranscriptTreePathNodes,
  selectSessionTranscriptTreeTipNodes,
} from "./transcript-tree.js";

type Navigation = ReturnType<typeof createSessionActorMemoryHistoryNavigation>;

function messageEvent(row: SessionActorMemoryHistoryRow): SessionTranscriptMessageEvent {
  return { event: row.event, eventSeq: row.rawSeq, seq: row.messagePosition! + 1 };
}

function boundedTail(
  window: SessionActorMemoryWindow,
  navigation: Navigation,
  options: SessionTranscriptBoundedMessageTailOptions,
): SessionTranscriptBoundedMessageTailPage {
  const { visibleMessages } = navigation;
  const totalMessages = visibleMessages.length;
  const offset = resolveIntegerOption(options.offset, 0, { min: 0, max: totalMessages });
  const maxMessages = resolveIntegerOption(options.maxMessages, 0, {
    min: 0,
    max: MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  });
  const maxBytes = resolveIntegerOption(options.maxBytes, 0, { min: 0 });
  const end = Math.max(0, totalMessages - offset);
  const start = Math.max(0, end - maxMessages);
  const oversized = options.oversizedMessageCheck;
  const checked = oversized
    ? {
        hasOversizedMessages: visibleMessages
          .slice(oversized.includeEarlier ? 0 : start, end)
          .some((row) => {
            const role = asOptionalRecord(asOptionalRecord(row.event)?.message)?.role;
            return (
              typeof role === "string" &&
              oversized.roles.includes(role) &&
              row.serializedBytes > maxBytes
            );
          }),
      }
    : {};
  const selected: SessionActorMemoryHistoryRow[] = [];
  let newestContiguousEventCount: number | undefined;
  let serializedBytes = 0;
  if (maxBytes > 0) {
    for (let index = end - 1; index >= start; index -= 1) {
      const row = visibleMessages[index]!;
      if (serializedBytes + row.serializedBytes > maxBytes) {
        newestContiguousEventCount ??= selected.length;
        continue;
      }
      selected.push(row);
      serializedBytes += row.serializedBytes;
    }
  }
  return {
    ...checked,
    activeLeafEntryId: navigation.tree.leafId,
    events: selected.toReversed().map(messageEvent),
    newestContiguousEventCount: newestContiguousEventCount ?? selected.length,
    scannedMessages: end - start,
    serializedBytes,
    snapshot: {
      boundarySeq: navigation.latestResetRawSeq ?? undefined,
      generation: window.hot.transcript.version.generation ?? undefined,
      indexedSeq: window.hot.transcript.version.rawSeq ?? -1,
    },
    totalMessages,
  };
}

function contextAccountingRows(navigation: Navigation): SessionActorMemoryHistoryRow[] {
  const { active } = navigation;
  const boundary = active.findLast(
    ({ event }) => isRecord(event) && (event.type === "reset" || event.type === "compaction"),
  );
  if (!boundary || !isRecord(boundary.event)) {
    return active.filter((row) => transcriptEventContextEligibility(row.event) === 1);
  }
  const boundaryEvent = boundary.event;
  const firstKeptId = boundaryEvent.firstKeptEntryId;
  const first = active.findIndex((row) => isRecord(row.event) && row.event.id === firstKeptId);
  const candidates =
    first >= 0 && first < boundary.activePosition
      ? active
          .slice(first, boundary.activePosition)
          .flatMap((row) =>
            isIndexedSessionEntry(row.event) &&
            row.event.type === "message" &&
            (boundaryEvent.type === "reset" || transcriptEventContextEligibility(row.event) === 1)
              ? [{ row, event: row.event }]
              : [],
          )
      : [];
  const retained =
    boundary.event.type === "reset"
      ? new Set(selectResetKeptEntries(candidates.map(({ event }) => event)))
      : undefined;
  return [
    ...candidates.flatMap(({ row, event }) => (!retained || retained.has(event) ? [row] : [])),
    ...(boundary.event.type === "compaction" ? [boundary] : []),
    ...active
      .slice(boundary.activePosition + 1)
      .filter((row) => transcriptEventContextEligibility(row.event) === 1),
  ];
}

function maintenance(
  window: SessionActorMemoryWindow,
  navigation: Navigation,
  request: SessionTranscriptMaintenanceRead,
): SessionTranscriptMaintenanceFacts {
  const kind = "transcript-maintenance";
  switch (request.operation) {
    case "previous":
      return {
        kind,
        previous: navigation.active.findLast(
          (row) => row.rawSeq < request.beforeSeq && row.node !== undefined,
        )?.event,
      };
    case "identity":
      return {
        kind,
        seq: window.events.find(({ event }) => isRecord(event) && event.id === request.eventId)
          ?.rawSeq,
      };
    case "version":
      return {
        kind,
        version: window.hot.transcript.version,
        lifecycleRevision: window.hot.entry?.lifecycleRevision,
        appendParentId: navigation.tree.appendParentId,
      };
    case "nested-activity": {
      const first = window.events.find(
        ({ event }) => isRecord(event) && event.id === request.firstEntryId,
      );
      const last = window.events.find(
        ({ event }) => isRecord(event) && event.id === request.lastEntryId,
      );
      if (!first || !last || first.rawSeq > last.rawSeq) {
        throw new Error("Accepted nested tool activity is no longer available");
      }
      return {
        kind,
        events: window.events.flatMap(({ event, rawSeq }) => {
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          return rawSeq >= first.rawSeq &&
            rawSeq <= last.rawSeq &&
            message?.customType === NESTED_TOOL_ACTIVITY_CUSTOM_TYPE &&
            asOptionalRecord(message.details)?.scopeId === request.scopeId
            ? [event]
            : [];
        }),
      };
    }
    case "suffix": {
      const rows = window.events.filter((row) => row.rawSeq >= request.startSeq);
      if (rows.length > request.maxEvents) {
        throw new Error("Transcript suffix exceeds synchronous planning row limit");
      }
      let bytes = 0;
      const retained = new Set(request.retainedCustomDataIds);
      const events = rows.map((row) => {
        const event = row.event;
        if (
          isRecord(event) &&
          event.type === "custom" &&
          typeof event.id === "string" &&
          retained.has(event.id)
        ) {
          const { data: _data, ...projected } = event;
          bytes += Buffer.byteLength(JSON.stringify(projected)) + 1;
          return projected;
        }
        bytes += Buffer.byteLength(row.eventJson) + 1;
        return event;
      });
      if (bytes > request.maxBytes) {
        throw new Error("Transcript suffix exceeds synchronous planning byte limit");
      }
      return { kind, events };
    }
  }
  throw new Error("Unknown memory transcript maintenance operation");
}

function branches(navigation: Navigation): SessionBranchSummary[] {
  const { tree } = navigation;
  return selectSessionTranscriptTreeTipNodes(tree)
    .toSorted(
      (left, right) =>
        Number(right.id === tree.leafId) - Number(left.id === tree.leafId) ||
        right.index - left.index,
    )
    .map((leaf) => {
      const path = selectSessionTranscriptTreePathNodes(tree, leaf.id);
      let headline = "";
      for (let index = path.length - 1; index >= 0 && !headline; index -= 1) {
        headline = extractSessionBranchHeadline(path[index]!.entry) ?? "";
      }
      const timestamp = asOptionalRecord(leaf.entry)?.timestamp;
      const branch: SessionBranchSummary = {
        leafEntryId: leaf.id,
        headline,
        messageCount: path.filter((node) => asOptionalRecord(node.entry)?.type === "message")
          .length,
        active: leaf.id === tree.leafId,
      };
      if (typeof timestamp === "string" && timestamp.trim()) {
        branch.updatedAt = timestamp;
      }
      return branch;
    });
}

/** Reads run synchronously in the owner's queue; its facade detaches only the selected result. */
export function readSessionActorMemoryHistoryFacts(
  window: SessionActorMemoryWindow,
  query: SessionActorMemoryHistoryFactsQuery,
): SessionActorMemoryHistoryFactsReads[keyof SessionActorMemoryHistoryFactsReads]["output"] {
  switch (query.type) {
    case "session.history.stats":
      return readSessionActorMemoryTranscriptStats(window);
    case "session.history.watermark":
      return { kind: "transcript-watermark", watermark: window.hot.transcript.watermark };
    case "session.history.message-presence":
      return window.events.some(({ event }) => isRecord(event) && event.type === "message");
    case "session.history.latest-assistant":
      for (let index = window.events.length - 1; index >= 0; index -= 1) {
        const event = asOptionalRecord(window.events[index]!.event);
        const message = asOptionalRecord(event?.message);
        if (
          event?.type !== "message" ||
          message?.role !== "assistant" ||
          isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
        ) {
          continue;
        }
        const text = projectAssistantTranscriptText(message, event.id);
        if (text) {
          return text;
        }
      }
      return undefined;
    default:
      break;
  }
  const navigation = createSessionActorMemoryHistoryNavigation(window);
  switch (query.type) {
    case "session.history.title": {
      const first = navigation.visibleMessages.slice(0, 100).find(({ event }) => {
        const message = asOptionalRecord(asOptionalRecord(event)?.message);
        return (
          projectSessionDisplayMessage(message)?.role === "user" &&
          (query.input.includeInterSession === true || !hasInterSessionUserProvenance(message))
        );
      });
      let lastMessagePreview: string | null = null;
      const tail = navigation.visibleMessages.slice(-100);
      for (let index = tail.length - 1; index >= 0 && lastMessagePreview === null; index -= 1) {
        lastMessagePreview =
          projectSessionDisplayMessage(asOptionalRecord(tail[index]!.event)?.message, {
            flattenMarkdown: true,
          })?.text ?? null;
      }
      return {
        kind: "session-title-fields",
        fields: {
          firstUserMessage:
            projectSessionDisplayMessage(asOptionalRecord(first?.event)?.message)?.text ?? null,
          lastMessagePreview,
        },
      };
    }
    case "session.history.preview": {
      const { maxItems, maxChars } = query.input;
      const initialMaxEvents = Math.min(256, Math.max(64, Math.ceil(maxItems) * 4));
      let items: ReturnType<typeof buildSessionPreviewItems> = [];
      for (const { maxEvents, maxBytes } of [
        { maxEvents: initialMaxEvents, maxBytes: 1024 * 1024 },
        {
          maxEvents: Math.min(2048, Math.max(1024, initialMaxEvents * 8, Math.ceil(maxItems))),
          maxBytes: 8 * 1024 * 1024,
        },
      ]) {
        const selected: SessionActorMemoryHistoryRow[] = [];
        let bytes = 0;
        for (
          let index = navigation.visibleHistory.length - 1;
          index >= 0 && selected.length < maxEvents;
          index -= 1
        ) {
          const row = navigation.visibleHistory[index]!;
          if (selected.length > 0 && bytes + row.serializedBytes > maxBytes) {
            break;
          }
          selected.push(row);
          bytes += row.serializedBytes;
        }
        items = buildSessionPreviewItems(
          selected.toReversed().map((row) => asOptionalRecord(row.event)?.message),
          maxItems,
          maxChars,
        );
        if (items.length >= maxItems || selected.length === navigation.visibleHistory.length) {
          break;
        }
      }
      return { kind: "session-preview", items };
    }
    case "session.history.branches":
      return window.hot.entry
        ? { status: "ok", ...window.hot.transcript.watermark, branches: branches(navigation) }
        : { status: "missing-session" };
    case "session.history.current-turn-entry": {
      const row = navigation.active.find(
        ({ event }) => isRecord(event) && event.id === query.input.entryId,
      );
      return {
        kind: "current-turn-entry",
        version: window.hot.transcript.version,
        anchor: window.hot.transcript.anchors.find(
          (anchor) => anchor.entryId === query.input.entryId,
        ),
        event:
          query.input.includeEntry && row && isIndexedSessionEntry(row.event)
            ? row.event
            : undefined,
      };
    }
    case "session.history.maintenance":
      return maintenance(window, navigation, query.input.request);
    case "session.history.match": {
      const match = query.input.match;
      const row = window.events.findLast(
        ({ event }) =>
          matchesTranscriptEvent(event, match) &&
          (match.kind !== "active-assistant" ||
            window.hot.transcript.anchors.some(
              (anchor) => anchor.entryId === asOptionalRecord(event)?.id,
            )),
      );
      return { kind: "transcript-match", result: row ? { event: row.event } : undefined };
    }
    case "session.history.latest-active-message": {
      const row = navigation.active.findLast((candidate) => candidate.messagePosition !== null);
      return row ? messageEvent(row) : undefined;
    }
    case "session.history.recent-active-events": {
      const limit = resolveIntegerOption(query.input.maxEvents, 0, { min: 0 });
      return limit === 0
        ? []
        : navigation.active
            .filter((row) => transcriptEventContextEligibility(row.event) === 1)
            .slice(-limit)
            .map((row) => row.event);
    }
    case "session.history.accounting": {
      const { options } = query.input;
      const contextRows = options.includeByteSize ? contextAccountingRows(navigation) : [];
      const limit = resolveIntegerOption(
        options.usageEventLimit ?? SQLITE_USAGE_TAIL_MAX_EVENTS,
        0,
        { min: 0 },
      );
      const tail =
        limit === 0
          ? []
          : navigation.active
              .filter((row) => transcriptEventContextEligibility(row.event) === 1)
              .slice(-limit);
      return {
        ...(options.includeByteSize
          ? {
              byteSize: contextRows.reduce((bytes, row) => bytes + row.serializedBytes, 0),
              eventCount: contextRows.length,
            }
          : {}),
        ...(options.includeUsage || options.includeTurnTaint
          ? readSessionTranscriptAccountingTail((visit) => {
              for (let index = tail.length - 1; index >= 0; index -= 1) {
                visit(tail[index]!.event);
              }
            }, options)
          : {}),
      };
    }
    case "session.history.bounded-tail":
      return boundedTail(window, navigation, query.input.options);
    case "session.history.visitor-source": {
      const rows = navigation.visibleMessages;
      const start = resolveIntegerOption(query.input.offset, 0, { min: 0, max: rows.length });
      const messages: Array<{ message: unknown; seq: number }> = [];
      let end = start;
      let bytes = 0;
      for (const row of rows.slice(start, start + SOURCE_PAGE_MAX_MESSAGES)) {
        if (row.serializedBytes > SOURCE_PAGE_MAX_BYTES) {
          throw new Error(
            `Transcript source message exceeds the ${SOURCE_PAGE_MAX_BYTES}-byte page limit`,
          );
        }
        if (bytes + row.serializedBytes > SOURCE_PAGE_MAX_BYTES) {
          break;
        }
        bytes += row.serializedBytes;
        end++;
        const message = asOptionalRecord(row.event)?.message;
        if (message !== undefined) {
          messages.push({ message, seq: row.messagePosition! + 1 });
        }
      }
      return { messages, ...(end < rows.length ? { nextOffset: end } : {}) };
    }
  }
  throw new Error("Unknown memory history facts query");
}
