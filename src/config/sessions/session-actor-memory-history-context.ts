import type { SessionTreeEntry } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { iterateSessionContextMessages } from "../../../packages/agent-core/src/harness/session/session.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionActorMemoryHistoryScope } from "./session-actor-memory-history-projection.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
  SessionTranscriptContextSnapshot,
} from "./session-history-read.types.js";
import { projectSessionModelContextEntry } from "./session-model-context-entry.js";
import { projectSessionModelContextNavigation } from "./session-model-context-navigation.js";
import { projectSessionModelContext } from "./session-model-context-read.js";
import type { ContextEntry, ModelContextRequest } from "./session-model-context-window.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** The requested prefix is a data-selection contract, not a second owner-currentness check. */
export function assertSessionActorMemoryAnchor(
  window: SessionActorMemoryWindow,
  scope: SessionActorMemoryHistoryScope,
  anchor: TranscriptEntryAnchor,
): void {
  const current = window.hot.transcript.anchors.find(
    (candidate) => candidate.entryId === anchor.entryId,
  );
  if (
    anchor.agentId !== scope.agentId ||
    anchor.storePath !== scope.path ||
    anchor.sessionKey !== window.hot.target.sessionKey ||
    anchor.sessionId !== window.hot.entry?.sessionId ||
    !current ||
    current.generation !== anchor.generation ||
    current.rawSeq !== anchor.rawSeq ||
    current.effectiveParentId !== anchor.effectiveParentId ||
    current.activeMessagePosition !== anchor.activeMessagePosition
  ) {
    throw new SessionTranscriptReadFenceError("Completed-turn transcript anchor changed");
  }
}

export function selectSessionActorMemoryAdmittedWindow(
  window: SessionActorMemoryWindow,
  scope: SessionActorMemoryHistoryScope,
  admission?: UserTurnTranscriptAdmissionReceipt,
): SessionActorMemoryWindow {
  if (!admission) {
    return window;
  }
  assertSessionActorMemoryAnchor(window, scope, admission);
  const admittedRow = window.events.find((row) => row.rawSeq === admission.rawSeq);
  if (
    !isRecord(admittedRow?.event) ||
    !isRecord(admittedRow.event.message) ||
    admittedRow.event.message.role !== "user"
  ) {
    throw new SessionTranscriptReadFenceError(
      "Transcript admission does not identify a user input",
    );
  }
  return { ...window, events: window.events.filter((row) => row.rawSeq < admission.rawSeq) };
}

/** Model payloads are detached only after the shared byte/frame selection has finished. */
export function readSessionActorMemoryContext(
  window: SessionActorMemoryWindow,
  scope: SessionActorMemoryHistoryScope,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
): SessionTranscriptModelContext {
  if (
    limits &&
    (!Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes <= 0 ||
      !Number.isSafeInteger(limits.maxEvents) ||
      limits.maxEvents <= 0)
  ) {
    throw new RangeError("Model-context byte and event limits must be positive safe integers");
  }
  if (through) {
    assertSessionActorMemoryAnchor(window, scope, through);
  }
  const rows = through
    ? window.events.filter((row) => row.rawSeq <= through.rawSeq)
    : window.events;
  const tree = scanSessionTranscriptTree(rows.map((row) => row.event));
  const originalEntries = new Map<number, SessionTreeEntry>();
  const entries: ContextEntry[] = normalizeSessionContextEntryBoundaries(
    selectSessionTranscriptTreePathNodes(tree, through?.entryId ?? tree.leafId).flatMap((node) => {
      if (!isIndexedSessionEntry(node.entry)) {
        return [];
      }
      const seq = rows[node.index]!.rawSeq;
      originalEntries.set(seq, node.entry);
      return [
        { ...projectSessionModelContextNavigation(node.entry), parentId: node.parentId, seq },
      ];
    }),
    tree.nodes,
  );
  const project = (request: ModelContextRequest) =>
    projectSessionModelContextEntry(originalEntries.get(request.entry.seq)!, request);
  return projectSessionModelContext(
    {
      header: rows.find((row) => isRecord(row.event) && row.event.type === "session")?.event,
      entries,
      version: { ...window.hot.transcript.version },
      readModelEntrySizes: (requests) =>
        new Map(
          requests.map((request) => [
            request.entry,
            Buffer.byteLength(JSON.stringify(project(request))),
          ]),
        ),
      readModelEntries: (requests) =>
        new Map(requests.map((request) => [request.entry, structuredClone(project(request))])),
    },
    limits,
  );
}

/** Full-fidelity context uses the same path and boundary policy as the native reader. */
export function readSessionActorMemoryContextMessages(
  window: SessionActorMemoryWindow,
): SessionTranscriptContextSnapshot {
  const tree = scanSessionTranscriptTree(window.events.map((row) => row.event));
  const entries = normalizeSessionContextEntryBoundaries(
    selectSessionTranscriptTreePathNodes(tree, tree.leafId).flatMap((node) =>
      isIndexedSessionEntry(node.entry) ? [{ ...node.entry, parentId: node.parentId }] : [],
    ),
    tree.nodes,
  );
  return {
    messages: Array.from(iterateSessionContextMessages(entries)),
    header: window.events.find((row) => isRecord(row.event) && row.event.type === "session")?.event,
    version: window.hot.transcript.version,
  };
}
