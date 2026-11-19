import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { isTranscriptArtifactProvider } from "../../../packages/agent-core/src/harness/session/transcript-model.js";
import { isSystemPromptUpdateBoundary } from "../../../packages/agent-core/src/operator-messages.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import {
  getActiveTranscriptKysely,
  readCurrentProjectionSnapshot,
} from "./session-accessor.sqlite-projection-read.js";
import type { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-read-scope.js";
import { readLatestActiveBoundaryMetadata } from "./session-accessor.sqlite-reset-window.js";
import type { ModelContextNavigationRow } from "./session-model-context-pages.js";
import type { ContextEntry } from "./session-model-context-window.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";

export const MODEL_CONTEXT_PAYLOAD_BATCH_SIZE = 400;

/** Borrow the active-path owner before projecting payloads in a compacted model window. */
export function readCompactedModelContextNavigation(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  readRows: (
    after: number,
    end: number,
    sequences?: number[],
  ) => Iterable<ModelContextNavigationRow>,
) {
  try {
    const result = readCurrentProjectionSnapshot(database, resolved, (projection) => {
      // Opaque imported ancestry needs the full tree's retained-anchor normalization.
      if (projection.hasUnindexedPrefix) {
        return undefined;
      }
      const boundary = readLatestActiveBoundaryMetadata(projection, "context");
      // Resets use paired retention; absent boundaries still need exact prefix byte costs.
      if (boundary?.event_type !== "compaction") {
        return undefined;
      }
      const boundaryRow = Array.from(readRows(boundary.seq - 1, boundary.seq))[0];
      if (boundaryRow?.entry.type !== "compaction") {
        return undefined;
      }
      const metadata = Array.from(
        iterateSqliteQuerySync(
          database.db,
          getActiveTranscriptKysely(database)
            .selectFrom("session_transcript_active_events as active")
            .leftJoin("transcript_event_identities as identity", (join) =>
              join
                .onRef("identity.session_id", "=", "active.session_id")
                .onRef("identity.seq", "=", "active.event_seq"),
            )
            .leftJoin("session_transcript_active_event_facts as facts", (join) =>
              join
                .onRef("facts.session_id", "=", "active.session_id")
                .onRef("facts.seq", "=", "active.event_seq"),
            )
            .select([
              "active.event_seq",
              "active.context_eligible",
              "identity.event_id",
              "identity.event_type",
              "facts.dependency_navigation_json",
            ])
            .where("active.session_id", "=", resolved.sessionId)
            .orderBy("active.active_position", "asc"),
        ),
      );
      // Missing identities or dependency facts cannot certify what the prefix omits.
      if (
        metadata.some(
          (row) =>
            row.event_id === null ||
            row.event_type === null ||
            row.dependency_navigation_json === null,
        )
      ) {
        return undefined;
      }
      const boundaryIndex = metadata.findIndex((row) => row.event_seq === boundary.seq);
      const keepId = boundaryRow.entry.firstKeptEntryId;
      const start =
        keepId === undefined ? boundaryIndex : metadata.findIndex((row) => row.event_id === keepId);
      // Unknown/off-branch keep markers retain the canonical reader's behavior.
      if (start <= 0 || start > boundaryIndex) {
        return undefined;
      }
      const prefix = metadata.slice(0, start);
      for (const row of prefix) {
        // Excluded prefix messages may own pending results, including duplicate-key imports.
        if (row.event_type === "message" && row.context_eligible === 0) {
          return undefined;
        }
        if (row.dependency_navigation_json !== "{}") {
          // SAFETY: Stored dependency navigation is produced by the transcript facts owner.
          const entry = JSON.parse(row.dependency_navigation_json!) as ContextEntry;
          // Placements and prompt restarts can affect entries outside this window.
          if (
            entry.type === "custom" &&
            (isSystemPromptUpdateBoundary(entry) ||
              entry.customType === BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE)
          ) {
            return undefined;
          }
        }
      }
      const window = metadata.slice(start);
      const rows = new Map([[boundary.seq, boundaryRow]]);
      for (const batch of chunkItems(
        window.filter((row) => row.event_seq !== boundary.seq),
        MODEL_CONTEXT_PAYLOAD_BATCH_SIZE,
      )) {
        for (const row of readRows(
          -1,
          projection.state.indexedSeq,
          batch.map((identity) => identity.event_seq),
        )) {
          rows.set(row.entry.seq, row);
        }
      }
      const hasModel = [...rows.values()].some(
        ({ entry }) =>
          (entry.type === "model_change" && !isTranscriptArtifactProvider(entry.provider)) ||
          (entry.type === "message" &&
            entry.message.role === "assistant" &&
            !isTranscriptArtifactProvider(entry.message.provider)),
      );
      // Without a model state in the window, inference may still depend on an old assistant.
      if (!hasModel) {
        return undefined;
      }
      const thinking = !window.some((row) => row.event_type === "thinking_level_change")
        ? prefix.findLast((row) => row.event_type === "thinking_level_change")
        : undefined;
      if (thinking) {
        for (const row of readRows(thinking.event_seq - 1, thinking.event_seq)) {
          rows.set(row.entry.seq, row);
        }
      }
      const entries: ContextEntry[] = [];
      for (const identity of thinking ? [thinking, ...window] : window) {
        const entry = rows.get(identity.event_seq)?.entry;
        // Native duplicate-member semantics must agree with the recorded identity.
        if (!entry || entry.id !== identity.event_id || entry.type !== identity.event_type) {
          return undefined;
        }
        entry.parentId = entries.at(-1)?.id ?? null;
        entries.push(entry);
      }
      return { rows, entries, observedSeqs: metadata.map((identity) => identity.event_seq) };
    });
    // Stale projections keep the original read path; readers never reconcile the writer.
    return result.kind === "value" ? result.value : undefined;
  } catch (error) {
    // Cold storage retains the original reader's payload and error contract.
    if (error instanceof SessionTranscriptColdError) {
      return undefined;
    }
    throw error;
  }
}
