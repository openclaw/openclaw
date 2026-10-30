import type { SessionTreeEntry } from "@openclaw/agent-core";
import {
  isPendingBackgroundResultMessage,
  projectPlacedBackgroundResultMessage,
  readBackgroundResultPlacement,
} from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import { isTranscriptArtifactProvider } from "../../../packages/agent-core/src/harness/session/transcript-model.js";
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
  type ModelContextPrefix,
} from "./session-model-context-window.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

/** Canonical request membership is shared by cold reads and committed append deltas. */
export function collectSessionModelContextRequests(entries: ContextEntry[]): ModelContextRequest[] {
  const requests: ModelContextRequest[] = [];
  for (const { entry, placement, context } of iterateSessionContextEntries(entries)) {
    const omitCheckpoint =
      context !== "current" &&
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      isCompactionReplayCheckpoint(entry.message.providerReplay);
    requests.push({ entry, ...(placement ? { placement } : {}), omitCheckpoint });
  }
  return requests;
}

/** Accepted artifacts remain recoverable until placed or retired by a history reset. */
export function collectSessionPendingBackgroundResultRequests(
  entries: ContextEntry[],
): ModelContextRequest[] {
  const pending = new Map<string, ModelContextRequest>();
  for (const entry of entries) {
    if (entry.type === "reset" || entry.type === "branch_summary") {
      pending.clear();
    }
    if (entry.type === "message" && isPendingBackgroundResultMessage(entry.message)) {
      pending.set(entry.id, { entry, omitCheckpoint: false });
    }
    for (const id of readBackgroundResultPlacement(entry)?.resultEntryIds ?? []) {
      pending.delete(id);
    }
  }
  return [...pending.values()];
}

/** Select before reading payloads; durable and memory backends share context projection. */
export function projectSessionModelContext(
  {
    header,
    entries,
    readModelEntries,
    readModelEntrySizes,
    version,
    prepared,
  }: {
    prepared?: { requests: ModelContextRequest[]; prefix: ModelContextPrefix };
    header: TranscriptEvent;
    entries: ContextEntry[];
    version: SessionTranscriptContextVersion;
    readModelEntries: (
      requests: readonly ModelContextRequest[],
    ) => Map<ContextEntry, SessionTreeEntry>;
    readModelEntrySizes: (requests: readonly ModelContextRequest[]) => Map<ContextEntry, number>;
  },
  limits?: SessionModelContextLimits,
): SessionTranscriptModelContext {
  const requests = prepared?.requests ?? collectSessionModelContextRequests(entries);
  const pending = collectSessionPendingBackgroundResultRequests(entries);
  const pendingBytes =
    limits && pending.length
      ? [...readModelEntrySizes(pending).values()].reduce((total, bytes) => total + bytes, 0)
      : 0;
  if (limits && pendingBytes > limits.maxBytes) {
    throw new RangeError("Required background result payload exceeds the model-context limit");
  }
  const selected = limits
    ? selectBoundedModelRequests(
        requests,
        readModelEntrySizes,
        { ...limits, maxBytes: limits.maxBytes - pendingBytes },
        prepared?.prefix,
      )
    : requests;
  const payloads = readModelEntries(pending.length ? [...selected, ...pending] : selected);
  const placedSources = new Set<ContextEntry>();
  const placements = new Map<ContextEntry, SessionTreeEntry[]>();
  for (const { entry, placement } of selected) {
    if (!placement) {
      continue;
    }
    const payload = payloads.get(entry);
    if (payload?.type !== "message") {
      throw new Error("Background result placement payload was not hydrated");
    }
    placedSources.add(entry);
    const projected = {
      ...payload,
      message: projectPlacedBackgroundResultMessage(payload.message),
    };
    const results = placements.get(placement);
    if (results) {
      results.push(projected);
    } else {
      placements.set(placement, [projected]);
    }
  }
  const placedPayload = (entry: ContextEntry): SessionTreeEntry[] | undefined =>
    placements.get(entry) ?? (placedSources.has(entry) ? [] : undefined);
  let contextEntries: SessionTreeEntry[];
  if (limits) {
    const model = entries.findLast(
      (entry) =>
        (entry.type === "model_change" && !isTranscriptArtifactProvider(entry.provider)) ||
        (entry.type === "message" &&
          entry.message.role === "assistant" &&
          !isTranscriptArtifactProvider(entry.message.provider)),
    );
    const thinking = entries.findLast((entry) => entry.type === "thinking_level_change");
    const detached = entries.flatMap((entry) => {
      const placed = placedPayload(entry);
      if (placed) {
        return placed;
      }
      const payload = payloads.get(entry);
      if (payload) {
        return [payload];
      }
      if (entry === thinking || (entry === model && entry.type === "model_change")) {
        return [{ ...entry }];
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
    contextEntries = entries.flatMap(
      (entry) => placedPayload(entry) ?? [payloads.get(entry) ?? { ...entry }],
    );
    // A retained cut can name the placement marker rather than its referenced artifact.
    for (const entry of contextEntries) {
      if (entry.type === "compaction" || entry.type === "reset") {
        const placement = entries.find((candidate) => candidate.id === entry.firstKeptEntryId);
        const firstPlaced = placement ? placements.get(placement)?.[0] : undefined;
        if (firstPlaced) {
          entry.firstKeptEntryId = firstPlaced.id;
        }
      }
    }
    if (placements.size > 0) {
      contextEntries = contextEntries.map((entry, index) => ({
        ...entry,
        parentId: contextEntries[index - 1]?.id ?? null,
      }));
    }
  }
  return {
    events: [...(header ? [header] : []), ...contextEntries],
    version,
  };
}
