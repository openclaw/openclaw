import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { isVisibleHistoryNonMessageEvent } from "./session-history-visibility.js";
import {
  hasTranscriptMessage,
  shouldProjectActiveEvent,
} from "./session-transcript-projection-append.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptActiveEntries,
  type SessionTranscriptTreeNode,
} from "./transcript-tree.js";

export type SessionActorMemoryHistoryRow = SessionActorMemoryWindow["events"][number] & {
  node: SessionTranscriptTreeNode<unknown> | undefined;
  activePosition: number;
  messagePosition: number | null;
  serializedBytes: number;
};

/** Derived selections borrow immutable event payloads from the actor's current command. */
export function createSessionActorMemoryHistoryNavigation(window: SessionActorMemoryWindow) {
  const tree = scanSessionTranscriptTree(window.events.map((row) => row.event));
  const nodes = new Map(tree.nodes.map((node) => [window.events[node.index], node]));
  let messagePosition = 0;
  const active = selectSessionTranscriptActiveEntries({
    entries: window.events,
    recordOf: (row) => row.event,
    tree,
    failClosedOnInvalidLeafControl: true,
  })
    .filter((row) => shouldProjectActiveEvent(row.event))
    .map((row, activePosition): SessionActorMemoryHistoryRow => ({
      rawSeq: row.rawSeq,
      event: row.event,
      eventJson: row.eventJson,
      createdAt: row.createdAt,
      searchOrder: row.searchOrder,
      node: nodes.get(row),
      activePosition,
      messagePosition: hasTranscriptMessage(row.event) ? messagePosition++ : null,
      serializedBytes: Buffer.byteLength(row.eventJson) + 1,
    }));
  const reset = active.findLast((row) => isRecord(row.event) && row.event.type === "reset");
  const firstKeptId = reset && isRecord(reset.event) ? reset.event.firstKeptEntryId : undefined;
  const firstKept =
    typeof firstKeptId === "string"
      ? active.find((row) => isRecord(row.event) && row.event.id === firstKeptId)
      : undefined;
  const candidates =
    reset && firstKept && firstKept.activePosition < reset.activePosition
      ? active
          .slice(firstKept.activePosition, reset.activePosition)
          .flatMap((row) =>
            isIndexedSessionEntry(row.event) && row.event.type === "message"
              ? [{ row, event: row.event }]
              : [],
          )
      : [];
  const retained = new Set(selectResetKeptEntries(candidates.map(({ event }) => event)));
  const keptMessages = candidates.flatMap(({ row, event }) =>
    retained.has(event) && (event.message.role === "user" || event.message.role === "assistant")
      ? [row]
      : [],
  );
  const afterReset = reset ? active.slice(reset.activePosition + 1) : active;
  const visibleMessages = [
    ...keptMessages,
    ...afterReset.filter((row) => row.messagePosition !== null),
  ];
  const visibleHistory = [
    ...keptMessages,
    ...(reset ? [reset] : []),
    ...afterReset.filter(
      (row) =>
        row.messagePosition !== null ||
        (isRecord(row.event) && isVisibleHistoryNonMessageEvent(row.event)),
    ),
  ];
  return {
    tree,
    active,
    visibleMessages,
    visibleHistory,
    latestResetRawSeq: reset?.rawSeq ?? null,
    keptMessages,
    boundaryActivePosition: reset?.activePosition,
  };
}
