import type { SessionTreeEntry } from "@openclaw/agent-core";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import { isCompactionReplayCheckpoint } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import {
  selectBoundedModelRequests,
  type ContextEntry,
  type ModelContextRequest,
} from "./session-model-context-window.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

/** Select before reading payloads; durable and memory backends share context projection. */
export function projectSessionModelContext(
  {
    header,
    entries,
    readModelEntries,
    readModelEntrySizes,
    version,
  }: {
    header: TranscriptEvent;
    entries: ContextEntry[];
    version: SessionTranscriptContextVersion;
    readModelEntries(requests: readonly ModelContextRequest[]): Map<ContextEntry, SessionTreeEntry>;
    readModelEntrySizes(requests: readonly ModelContextRequest[]): Map<ContextEntry, number>;
  },
  limits?: SessionModelContextLimits,
): SessionTranscriptModelContext {
  const requests: ModelContextRequest[] = [];
  for (const { entry, context } of iterateSessionContextEntries(entries)) {
    const omitCheckpoint =
      context !== "current" &&
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      isCompactionReplayCheckpoint(entry.message.providerReplay);
    requests.push({ entry, omitCheckpoint });
  }
  const selected = limits
    ? selectBoundedModelRequests(requests, readModelEntrySizes, limits)
    : requests;
  const payloads = readModelEntries(selected);
  let contextEntries: SessionTreeEntry[];
  if (limits) {
    const model = entries.findLast(
      (entry) =>
        entry.type === "model_change" ||
        (entry.type === "message" && entry.message.role === "assistant"),
    );
    const thinking = entries.findLast((entry) => entry.type === "thinking_level_change");
    const detached = entries.flatMap((entry) => {
      const payload = payloads.get(entry);
      if (payload) {
        return [payload];
      }
      if (entry === thinking || (entry === model && entry.type === "model_change")) {
        return [entry];
      }
      if (entry === model && entry.type === "message" && entry.message.role === "assistant") {
        return [
          {
            type: "model_change" as const,
            id: entry.id,
            parentId: entry.parentId,
            timestamp: entry.timestamp,
            provider: entry.message.provider,
            modelId: entry.message.model,
          },
        ];
      }
      return [];
    });
    const boundaryIndex = detached.findIndex(
      (entry) => entry.type === "compaction" || entry.type === "reset",
    );
    const boundary = detached[boundaryIndex];
    if (boundary?.type === "compaction" || boundary?.type === "reset") {
      boundary.firstKeptEntryId =
        detached
          .slice(0, boundaryIndex)
          .find(
            (entry) =>
              entry.type === "message" ||
              entry.type === "custom_message" ||
              entry.type === "branch_summary",
          )?.id ?? boundary.id;
    }
    contextEntries = detached.map((entry, index) => {
      entry.parentId = detached[index - 1]?.id ?? null;
      return entry;
    });
  } else {
    contextEntries = entries.map((entry) => payloads.get(entry) ?? entry);
  }
  return {
    events: [...(header ? [header] : []), ...contextEntries],
    version,
  };
}
