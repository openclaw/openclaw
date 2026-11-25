import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { ClosedTranscriptTurnReadResult } from "./session-accessor.transcript-range.worker.js";
import { assertSessionActorMemoryAnchor } from "./session-actor-memory-history-context.js";
import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import { resolveSessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { TranscriptTurnBoundary } from "./transcript-entry-anchor.js";

/** The anchors select exact committed data; no separate owner-currentness read is needed. */
export function readSessionActorMemoryClosedTurn(
  context: SessionActorMemoryStorageContext,
  input: { boundary: TranscriptTurnBoundary; maxEvents: number; maxBytes: number },
): ClosedTranscriptTurnReadResult {
  const { admission, terminal } = input.boundary;
  if (
    admission.agentId !== terminal.agentId ||
    admission.storePath !== terminal.storePath ||
    admission.sessionKey !== terminal.sessionKey ||
    admission.sessionId !== terminal.sessionId ||
    admission.generation !== terminal.generation ||
    admission.sessionKey !== context.state.hot.target.sessionKey
  ) {
    return { kind: "session-rebound" };
  }
  const window = resolveSessionActorMemoryWindow(context.state, admission.sessionId);
  if (!window) {
    return { kind: "session-rebound" };
  }
  try {
    assertSessionActorMemoryAnchor(window, context, admission);
    assertSessionActorMemoryAnchor(window, context, terminal);
  } catch (error) {
    if (error instanceof SessionTranscriptReadFenceError) {
      return { kind: "stale" };
    }
    throw error;
  }
  const navigation = createSessionActorMemoryHistoryNavigation(window);
  const first = navigation.active.find((row) => row.rawSeq === admission.rawSeq);
  if (
    !first ||
    !isIndexedSessionEntry(first.event) ||
    first.event.type !== "message" ||
    first.event.message.role !== "user"
  ) {
    return { kind: "stale" };
  }
  const nodes = new Map(navigation.tree.nodes.map((node) => [node.id, node]));
  let cursor: string | null = terminal.entryId;
  let depth = 0;
  const visited = new Set<string>();
  while (cursor !== admission.entryId) {
    if (!cursor || visited.has(cursor)) {
      return { kind: "non-descendant" };
    }
    if (depth++ >= input.maxEvents) {
      return { kind: "too-large" };
    }
    visited.add(cursor);
    cursor = nodes.get(cursor)?.parentId ?? null;
  }
  const rows = navigation.active.filter(
    (row) =>
      row.messagePosition !== null &&
      row.messagePosition >= admission.activeMessagePosition &&
      row.messagePosition <= terminal.activeMessagePosition,
  );
  if (
    rows.length > input.maxEvents ||
    rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.eventJson), 0) > input.maxBytes
  ) {
    return { kind: "too-large" };
  }
  const messages: AgentMessage[] = rows.flatMap(({ event }) =>
    isIndexedSessionEntry(event) && event.type === "message" ? [event.message] : [],
  );
  return { kind: "ok", messages };
}
