import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { SessionTranscriptBoundedActiveContext } from "./session-accessor.sqlite-contract.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import {
  normalizeBoundedContextLimits,
  selectBoundedContextRows,
} from "./session-bounded-context-selection.js";
import { collectCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix-values.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionTranscriptContextSelection,
} from "./session-history-read.types.js";
import {
  shouldProjectActiveEvent,
  transcriptEventContextEligibility,
} from "./session-transcript-projection-append.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

export type SessionActorTranscriptRow = { rawSeq: number; event: unknown; serializedBytes: number };

/** Select from bytes already held by the actor, using the same bounded-window policy. */
export function readSessionActorBoundedHistory(
  state: { hot: SessionActorHotState; events: SessionActorTranscriptRow[] },
  limits: SessionTranscriptContextSelection,
): Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }> {
  const version = { ...state.hot.transcript.version };
  const boundedLimits = normalizeBoundedContextLimits(limits);
  const navigation = scanSessionTranscriptTree(state.events.map((row) => row.event));
  const active = selectSessionTranscriptTreePathNodes(navigation, navigation.leafId)
    .filter((node) => shouldProjectActiveEvent(node.entry))
    .map((node, activePosition) => {
      const row = state.events[node.index]!;
      return {
        rawSeq: row.rawSeq,
        event: row.event,
        node,
        activePosition,
        serialized_bytes: row.serializedBytes,
      };
    });
  const header = state.events.find((row) => isRecord(row.event) && row.event.type === "session");
  const headerBytes = header ? header.serializedBytes : 0;
  const boundaries = active.filter(
    ({ event }) => isRecord(event) && (event.type === "reset" || event.type === "compaction"),
  );
  const boundary = boundaries.at(-1);
  const boundaryEvent = !boundedLimits && boundary?.event;
  const firstKept = isRecord(boundaryEvent)
    ? active.find((row) => row.node.id === boundaryEvent.firstKeptEntryId)
    : undefined;
  const contextStart =
    firstKept && boundary && firstKept.activePosition < boundary.activePosition
      ? firstKept.activePosition
      : (boundary?.activePosition ?? 0);
  const resetKept =
    boundary && isRecord(boundaryEvent) && boundaryEvent.type === "reset"
      ? new Set<unknown>(
          selectResetKeptEntries(
            active
              .slice(contextStart, boundary.activePosition)
              .flatMap(({ event }) => (isIndexedSessionEntry(event) ? [event] : [])),
          ),
        )
      : undefined;
  const retained = new Set(
    boundedLimits && state.hot.transcript.modelContext.kind === "resident"
      ? state.hot.transcript.modelContext.entries.map((entry) => entry.rawSeq)
      : [],
  );
  const eligible = active.filter((row) => {
    if (!boundedLimits && boundary && row.activePosition < boundary.activePosition) {
      return resetKept
        ? resetKept.has(row.event)
        : row.activePosition >= contextStart && transcriptEventContextEligibility(row.event) === 1;
    }
    return transcriptEventContextEligibility(row.event) === 1 || retained.has(row.rawSeq);
  });
  const selection = selectBoundedContextRows(eligible.toReversed(), headerBytes, boundedLimits);
  const { selectedRows } = selection;
  let { serializedBytes, truncated } = selection;
  const rows = selectedRows.toSorted((left, right) => left.rawSeq - right.rawSeq);
  let injected: typeof boundary;
  if (boundary && !selectedRows.includes(boundary)) {
    if (!boundedLimits || serializedBytes + boundary.serialized_bytes <= boundedLimits.maxBytes) {
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
