import type { CompactionEntrySource } from "../../../packages/agent-core/src/harness/compaction/compaction-entry-source.js";
import type { CompactionContextProjection } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { iterateSessionContextMessages } from "../../../packages/agent-core/src/harness/session/session.js";
import { selectResetKeptEntries } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { TranscriptContextSnapshot } from "./session-accessor.sqlite-model-context.js";

/** Compaction consumes the replay owner's navigation and full-fidelity lazy reads. */
export function createSessionCompactionEntrySource(snapshot: TranscriptContextSnapshot) {
  const { entries, readEntry } = snapshot;
  const source: CompactionEntrySource = {
    length: entries.length,
    metadata: (index) => entries[index],
    get(index) {
      const entry = entries[index];
      return entry ? readEntry(entry) : undefined;
    },
  };
  const context: CompactionContextProjection = {
    messages: () => iterateSessionContextMessages(entries, readEntry),
    resetKeptEntryIndices(startIndex, endIndex) {
      const retained = new Set(selectResetKeptEntries(entries.slice(startIndex, endIndex)));
      const indices: number[] = [];
      for (let i = startIndex; i < endIndex; i++) {
        if (retained.has(entries[i]!)) {
          indices.push(i);
        }
      }
      return indices;
    },
  };
  return { source, context };
}
