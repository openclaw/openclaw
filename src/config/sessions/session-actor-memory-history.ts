import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionTranscriptBoundedActiveContext } from "./session-accessor.sqlite-contract.js";
import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "./session-accessor.sqlite-visible-cursor.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import { selectBoundedContextRows } from "./session-bounded-context-selection.js";
import { collectCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix-values.js";
import type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";
import {
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** The actor already owns these bytes; limits select a detached view, never a second store. */
export function readSessionActorMemoryHistory(
  state: SessionActorMemoryState,
  limits?: { maxBytes: number; maxEvents: number },
): PreparedSessionTranscriptHydration {
  const version = { ...state.hot.transcript.version };
  if (!limits) {
    return {
      kind: "full",
      snapshot: {
        events: structuredClone(state.events.map((row) => row.event)),
        eventJson: state.events.map((row) => row.eventJson),
        eventSeqs: state.events.map((row) => row.rawSeq),
        version,
      },
    };
  }
  const maxBytes = normalizeVisibleMessageLimit(
    limits.maxBytes,
    DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
    MAX_VISIBLE_MESSAGE_MAX_BYTES,
    "maxBytes",
  );
  const maxEvents = normalizeVisibleMessageLimit(
    limits.maxEvents,
    DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
    MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    "maxEvents",
  );
  const navigation = scanSessionTranscriptTree(state.events.map((row) => row.event));
  const active = selectSessionTranscriptTreePathNodes(navigation, navigation.leafId)
    .filter((node) => shouldProjectActiveEvent(node.entry))
    .map((node, activePosition) => {
      const row = state.events[node.index]!;
      return {
        rawSeq: row.rawSeq,
        event: row.event,
        eventJson: row.eventJson,
        node,
        activePosition,
        serialized_bytes: Buffer.byteLength(row.eventJson) + 1,
      };
    });
  const header = state.events.find((row) => isRecord(row.event) && row.event.type === "session");
  const headerBytes = header ? Buffer.byteLength(header.eventJson) + 1 : 0;
  const retained = new Set(
    state.hot.transcript.modelContext.kind === "resident"
      ? state.hot.transcript.modelContext.entries.map((entry) => entry.rawSeq)
      : [],
  );
  const eligible = active.filter(
    (row) => transcriptEventContextEligibility(row.event) === 1 || retained.has(row.rawSeq),
  );
  const selection = selectBoundedContextRows(eligible.toReversed(), headerBytes, {
    maxBytes,
    maxEvents,
  });
  const { selectedRows } = selection;
  let { serializedBytes, truncated } = selection;
  const boundaries = active.filter(
    ({ event }) => isRecord(event) && (event.type === "reset" || event.type === "compaction"),
  );
  const boundary = boundaries.at(-1);
  const rows = selectedRows.toSorted((left, right) => left.rawSeq - right.rawSeq);
  let injected: typeof boundary;
  if (boundary && !selectedRows.includes(boundary)) {
    if (serializedBytes + boundary.serialized_bytes <= maxBytes) {
      injected = boundary;
      rows.unshift(boundary);
      serializedBytes += boundary.serialized_bytes;
    } else {
      truncated = true;
    }
  }
  const parents = new Map(
    rows.map((row) => [row.node.id, active[row.activePosition - 1]?.node.id ?? null]),
  );
  const opaqueParents = new Map<string, string | null>();
  let previousId: string | undefined;
  for (const row of rows) {
    const event = row.event;
    if (row === injected) {
      previousId = row.node.id;
    } else if (isRecord(event) && "parentId" in event) {
      if (
        previousId !== undefined &&
        typeof event.parentId === "string" &&
        event.parentId !== previousId
      ) {
        opaqueParents.set(event.parentId, previousId);
      }
      previousId = row.node.id;
    }
  }
  if (navigation.leafId && navigation.leafId !== previousId) {
    opaqueParents.set(navigation.leafId, previousId ?? null);
  }
  const headerOffset = header ? 1 : 0;
  const firstKeptRanges: SessionTranscriptBoundedActiveContext["firstKeptRanges"] = new Map();
  for (const [endIndex, row] of rows.entries()) {
    const event = row.event;
    if (
      !isRecord(event) ||
      (event.type !== "reset" && event.type !== "compaction") ||
      typeof event.firstKeptEntryId !== "string"
    ) {
      continue;
    }
    const first = active.find((candidate) => candidate.node.id === event.firstKeptEntryId);
    if (!first) {
      continue;
    }
    let startIndex = endIndex > 0 && rows[0]!.rawSeq >= first.rawSeq ? 0 : Math.min(1, endIndex);
    while (startIndex < endIndex && rows[startIndex]!.rawSeq < first.rawSeq) {
      startIndex++;
    }
    firstKeptRanges.set(row.node.id, {
      startIndex: startIndex + headerOffset,
      endIndex: endIndex + headerOffset,
    });
  }
  const anchors = [
    ...(injected && isRecord(injected.event) && injected.event.type === "compaction"
      ? [injected]
      : []),
    ...(selectedRows.at(-1) ? [selectedRows.at(-1)!] : []),
  ];
  const cacheTtlProjectionPrefixes = anchors.flatMap((anchor) => {
    const prefix = collectCacheTtlProjectionPrefix(
      { id: anchor.node.id, entry: anchor.event },
      active
        .slice(0, anchor.activePosition)
        .toReversed()
        .map((row) => row.event),
    );
    return prefix ? [prefix] : [];
  });
  return {
    kind: "bounded",
    snapshot: {
      version,
      activeLeafEntryId: navigation.leafId,
      opaqueParents,
      parents,
      firstKeptRanges,
      persistedSuffixStartSeq: rows[0]?.rawSeq ?? (header ? header.rawSeq + 1 : 0),
      boundaryCount: boundaries.length,
      events: structuredClone([...(header ? [header.event] : []), ...rows.map((row) => row.event)]),
      cacheTtlProjectionPrefixes: structuredClone(cacheTtlProjectionPrefixes),
      serializedBytes,
      totalEvents: active.length,
      transcriptMutationAt: version.updatedAt,
      truncated,
      ...(!truncated && selectedRows.length === active.length ? { completeActivePath: true } : {}),
    },
  };
}
