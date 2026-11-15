import { RUNTIME_CONTEXT_CUSTOM_TYPE } from "@openclaw/llm-core";
import { projectSessionEntryMessage } from "../../../packages/agent-core/src/harness/session/session.js";
import {
  getOpenClawSystemUpdateKind,
  isSystemPromptUpdateBoundary,
  SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE,
} from "../../../packages/agent-core/src/operator-messages.js";
import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import {
  isSessionTranscriptReplayMetadataType,
  validateSessionTranscriptReplaySelection,
  type SessionTranscriptReplayGroup,
  type SessionTranscriptReplaySelection,
} from "./session-transcript-replay.types.js";

/** Select the full active path, then apply the actor's validated admission fence. */
export function readSessionActorMemoryReplayGroups(
  window: SessionActorMemoryWindow,
  selection: SessionTranscriptReplaySelection,
  beforeRawSeq = Number.MAX_SAFE_INTEGER,
): SessionTranscriptReplayGroup[] {
  const maxBytes = validateSessionTranscriptReplaySelection(selection);
  const { active } = createSessionActorMemoryHistoryNavigation(window);
  const byId = new Map(active.map((row) => [row.node?.id, row]));
  const operatorBoundary = active.findLastIndex(
    (row) => row.rawSeq < beforeRawSeq && isSystemPromptUpdateBoundary(row.event),
  );
  let bytes = 0;
  const hydrate = (row: (typeof active)[number]) => {
    bytes += row.serializedBytes;
    if (bytes > maxBytes) {
      throw new RangeError(`Session transcript replay exceeds maxBytes (${maxBytes})`);
    }
    if (!isIndexedSessionEntry(row.event)) {
      throw new Error("Selected replay entry is not a readable session entry");
    }
    return projectSessionEntryMessage(row.event);
  };
  const groups: SessionTranscriptReplayGroup[] = [];
  for (const entryId of new Set(selection.entryIds)) {
    const row = byId.get(entryId);
    if (
      !row ||
      row.rawSeq >= beforeRawSeq ||
      !isIndexedSessionEntry(row.event) ||
      row.event.type !== "message" ||
      row.event.message.role !== "user"
    ) {
      continue;
    }
    const message = hydrate(row);
    if (!message) {
      continue;
    }
    const group: SessionTranscriptReplayGroup = { entryId, message, carriers: [] };
    // Skip bookkeeping, but never cross a model message or history boundary to borrow context.
    for (let position = row.activePosition + 1; position < active.length; position++) {
      const next = active[position]!;
      if (!isIndexedSessionEntry(next.event) || next.rawSeq >= beforeRawSeq) {
        break;
      }
      if (
        isSessionTranscriptReplayMetadataType(
          next.event.type,
          next.event.type === "custom" ? next.event.customType : undefined,
        )
      ) {
        continue;
      }
      if (
        next.event.type !== "custom_message" ||
        (next.event.customType !== RUNTIME_CONTEXT_CUSTOM_TYPE &&
          next.event.customType !== SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE)
      ) {
        break;
      }
      if (
        position < operatorBoundary &&
        getOpenClawSystemUpdateKind(next.event) === "prompt-update"
      ) {
        continue;
      }
      const carrier = hydrate(next);
      if (carrier) {
        group.carriers.push(carrier);
      }
    }
    groups.push(group);
  }
  return groups;
}
