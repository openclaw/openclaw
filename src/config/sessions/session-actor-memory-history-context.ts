import type { SessionTreeEntry } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { projectModelContextMessages } from "../../shared/model-context-message.js";
import type { SessionActorMemoryHistoryScope } from "./session-actor-memory-history-projection.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import {
  MODEL_CONTEXT_NAVIGATION_KEYS,
  MODEL_MESSAGE_NAVIGATION_KEYS,
} from "./session-model-context-navigation.js";
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

function pickNavigation(record: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
  );
}
function navigationEntry(entry: SessionTreeEntry): SessionTreeEntry {
  const projected: Pick<SessionTreeEntry, "type" | "id" | "parentId" | "timestamp"> &
    Record<string, unknown> = {
    ...pickNavigation({ ...entry }, MODEL_CONTEXT_NAVIGATION_KEYS),
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };
  if (entry.type === "message") {
    const message = entry.message;
    const original: Record<string, unknown> = { ...message };
    const calls =
      "content" in message && Array.isArray(message.content)
        ? message.content.flatMap((item) =>
            isRecord(item) && ["toolCall", "toolUse", "functionCall"].includes(item.type)
              ? [pickNavigation(item, ["type", "id", "name"])]
              : [],
          )
        : [];
    const details = isRecord(original.details) ? original.details : {};
    const operatorKind =
      original.customType === "openclaw.system-update" &&
      (details.kind === "prompt-update" || details.kind === "runtime-context")
        ? details.kind
        : undefined;
    projected.message = {
      ...pickNavigation(original, MODEL_MESSAGE_NAVIGATION_KEYS),
      content: calls,
      command: "",
      output: "",
      providerReplay: {
        type: isRecord(original.providerReplay) ? original.providerReplay.type : null,
      },
      details: {
        [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: isSyntheticMissingToolResult({
          isError: original.isError,
          details: original.details,
          content: original.content,
        }),
        ...(operatorKind ? { kind: operatorKind } : {}),
      },
    };
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    projected.summary = "";
  } else if (entry.type === "custom_message") {
    projected.content = [];
    if (
      entry.customType === "openclaw.system-update" &&
      isRecord(entry.details) &&
      (entry.details.kind === "prompt-update" || entry.details.kind === "runtime-context")
    ) {
      projected.details = { kind: entry.details.kind };
    }
  } else if (entry.type === "custom" && entry.customType === "openclaw.system-prompt") {
    projected.data = { restart: isRecord(entry.data) && entry.data.restart === true };
  }
  // SAFETY: Navigation preserves every entry discriminant and control field with empty payloads.
  return projected as SessionTreeEntry;
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
      return [{ ...navigationEntry(node.entry), parentId: node.parentId, seq }];
    }),
    tree.nodes,
  );
  const project = (request: ModelContextRequest): SessionTreeEntry => {
    const { entry, omitCheckpoint, toolResultOmission } = request;
    const original = originalEntries.get(entry.seq)!;
    const event = {
      ...original,
      parentId: entry.parentId,
      ...(entry.type === "compaction" || entry.type === "reset"
        ? { firstKeptEntryId: entry.firstKeptEntryId }
        : {}),
    };
    if (event.type !== "message") {
      return event;
    }
    const [message] = projectModelContextMessages([event.message]);
    const projected = { ...event, message: message! };
    if (omitCheckpoint && projected.message.role === "assistant") {
      projected.message = { ...projected.message };
      delete projected.message.providerReplay;
    }
    if (toolResultOmission !== undefined && projected.message.role === "toolResult") {
      projected.message = {
        ...projected.message,
        content: [{ type: "text", text: toolResultOmission }],
      };
    }
    return projected;
  };
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
