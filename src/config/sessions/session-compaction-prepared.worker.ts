import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { getMessageFromEntryForCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  collectCompactionPreparationEntryFact,
  prepareCompactionEntryFacts,
} from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import { collectConversationMessageFact } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import { iterateSessionContextEntryFacts } from "../../../packages/agent-core/src/harness/session/session.js";
import { sanitizeCompactionMessages } from "../../agents/compaction-planning.js";
import {
  prepareCompactionPlan,
  finalizePreparedCompaction,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.js";
import { prepareNativeCompactionReplay } from "../../agents/embedded-agent-runner/prepared-compaction-replay.js";
import { readModelSnapshotStateFromEntries } from "../../agents/embedded-agent-runner/replay-model-snapshot.js";
import type { SessionEntry, SessionHeader } from "../../agents/sessions/session-manager-types.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { readSessionTranscriptCompactionPlan } from "./session-accessor.sqlite-active-context.js";
import { iterateUnindexedActiveTranscriptNavigation } from "./session-accessor.sqlite-history-navigation.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { selectActiveTranscriptIdentityRows } from "./session-accessor.sqlite-projection-read.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type {
  PreparedCompactionEntry,
  PreparedCompactionSource,
  SessionPreparedCompactionInput,
  SessionPreparedCompactionValue,
} from "./session-compaction-prepared.types.js";
import {
  renderPreparedSessionCompaction,
  withCompactionSourceRows,
} from "./session-compaction-render.worker.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
  isIndexedSessionEntry,
} from "./session-entry-codec.js";
import {
  readSessionEntryBranch,
  resolveSessionCanonicalParentId,
} from "./session-entry-navigation.js";
import { readSessionCompactionPreparation } from "./session-transcript-hydration.worker.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

/** Extract facts in the baseline native cursor; no facts table or payload graph survives. */
export async function readPreparedSessionCompaction(
  request: SessionPreparedCompactionInput,
  control: WorkerTaskControl,
): Promise<SessionPreparedCompactionValue> {
  const { operation } = request;
  if (operation.kind === "render") {
    const { value: conversation, reads } = await renderPreparedSessionCompaction(
      { ...request, operation },
      control,
    );
    return { kind: "compaction-preparation", status: "rendered", conversation, reads };
  }
  if (operation.kind === "finalize") {
    const { value, reads } = await withCompactionSourceRows(
      request,
      control,
      ({ database, readEntry, readEntriesAfter }) => {
        const retained = [
          ...operation.retainedSequences.map(readEntry),
          ...readEntriesAfter(operation.version.rawSeq ?? 0),
        ];
        return {
          transcriptMutationAt: readTranscriptContextVersionInTransaction(
            database,
            request.resolvedScope.sessionId,
          ).updatedAt,
          ...finalizePreparedCompaction(
            retained,
            operation.summary,
            operation.work,
            operation.reportingBudget,
          ),
        };
      },
    );
    return { kind: "compaction-preparation", status: "finalized", ...value, reads };
  }
  const { value, reads } = await withCompactionSourceRows(
    request,
    control,
    ({ database, readEntry, reads: sourceReads }) => {
      let source: PreparedCompactionSource;
      if (operation.kind === "plan" && operation.source) {
        source = operation.source;
        validateSessionTranscriptContextInDatabase(database, request.resolvedScope, {
          version: source.version,
          admission: request.admission,
        });
      } else {
        const facts = new Map<number, PreparedCompactionEntry>();
        let header: SessionHeader | undefined;
        let selected: number[] = [];
        let branchMetadata: SessionEntry[] = [];
        const snapshot = readSessionTranscriptCompactionPlan(request.target, {
          compaction: true,
          readOnly: true,
          resolvedScope: request.resolvedScope,
          transaction: database,
          onEntry: (event, row) => {
            control.throwIfCancelled();
            sourceReads.extractedRows++;
            sourceReads.extractedBytes += row.serializedBytes;
            if (isIndexedSessionEntry(event)) {
              const message = getMessageFromEntryForCompaction(event);
              facts.set(row.rawSeq, {
                ...collectCompactionPreparationEntryFact(event, row.rawSeq),
                parentId: event.parentId,
                idempotencyKey:
                  event.type === "message" &&
                  event.message.role === "user" &&
                  "idempotencyKey" in event.message &&
                  typeof event.message.idempotencyKey === "string"
                    ? event.message.idempotencyKey
                    : undefined,
                conversation: message
                  ? convertToLlm(sanitizeCompactionMessages([message])).map((projected, index) =>
                      collectConversationMessageFact(projected, { seq: row.rawSeq, index }),
                    )
                  : [],
              });
            } else {
              header ??= findSessionTranscriptHeader([event]);
            }
          },
          onRead: (projection, rows) => {
            selected = rows.map((row) => row.rawSeq);
            const fence = resolveSqliteSessionTranscriptReadFence({
              database,
              ...request.resolvedScope,
            });
            // SDK initialization inspects the whole active branch, not only the retained suffix.
            const metadataRows = Array.from(
              iterateSqliteQuerySync(
                database.db,
                selectActiveTranscriptIdentityRows(database)
                  .select(["identity.seq", "active.active_position"])
                  .where("identity.session_id", "=", request.resolvedScope.sessionId)
                  .where("identity.event_type", "in", ["thinking_level_change", "custom"])
                  .$if(fence !== undefined, (query) =>
                    query.where("identity.seq", "<", fence!.beforeRawSeq),
                  ),
              ),
            );
            for (const row of iterateUnindexedActiveTranscriptNavigation(projection, {
              maxRawSeq: fence ? fence.beforeRawSeq - 1 : undefined,
            })) {
              if (row.event.type === "thinking_level_change" || row.event.type === "custom") {
                metadataRows.push({ seq: row.event_seq, active_position: row.active_position });
              }
            }
            branchMetadata = metadataRows
              .toSorted((a, b) => a.active_position - b.active_position)
              .flatMap((row) => {
                const entry = readEntry(row.seq);
                return entry.type === "thinking_level_change" ||
                  (entry.type === "custom" && entry.customType === "model-snapshot")
                  ? [entry]
                  : [];
              });
          },
        });
        if (header) {
          assertCurrentSessionTranscriptHeader(header);
        }
        const byId = new Map(
          selected.flatMap((seq) => {
            const entry = facts.get(seq);
            return entry ? [[entry.id, entry] as const] : [];
          }),
        );
        const firstKept = new Map<string, string>();
        for (const [id, range] of snapshot.firstKeptRanges) {
          firstKept.set(
            id,
            selected
              .slice(range.startIndex, range.endIndex)
              .map((seq) => facts.get(seq)?.id)
              .find((entryId) => entryId !== undefined) ?? id,
          );
        }
        const entries = readSessionEntryBranch(snapshot.activeLeafEntryId, (id) => {
          const entry = byId.get(id);
          if (!entry) {
            return { parentId: snapshot.opaqueParents.get(id) ?? null };
          }
          const parent = snapshot.parents.has(id)
            ? (snapshot.parents.get(id) ?? null)
            : entry.parentId;
          const canonical = resolveSessionCanonicalParentId(parent, byId, snapshot.opaqueParents);
          const parentId = canonical === id ? null : canonical;
          const boundary = firstKept.get(id);
          return {
            entry: {
              ...entry,
              parentId,
              ...(boundary === undefined ? {} : { firstKeptEntryId: boundary }),
            },
            parentId,
          };
        });
        source = {
          entries,
          metadata: {
            hasExistingSession: !iterateSessionContextEntryFacts(entries).next().done,
            hasThinkingEntry: branchMetadata.some(
              (entry) => entry.type === "thinking_level_change",
            ),
            leafEntryId: snapshot.activeLeafEntryId,
            lastModelSnapshot: readModelSnapshotStateFromEntries(branchMetadata).lastSnapshot,
          },
          snapshotState: readModelSnapshotStateFromEntries(branchMetadata),
          header,
          version: snapshot.version,
          leafEntryId: snapshot.activeLeafEntryId,
          boundaryCount: snapshot.boundaryCount,
          persistedSuffixStartSeq: snapshot.persistedSuffixStartSeq,
          transcriptMutationAt: snapshot.transcriptMutationAt,
          eventCount: snapshot.totalEvents,
        };
      }
      return {
        source,
        planned:
          operation.kind === "plan"
            ? prepareCompactionPlan(
                source.entries,
                {
                  ...operation.work,
                  settings: operation.settings,
                  requestState: operation.requestState,
                },
                readEntry,
              )
            : undefined,
        replayEntries:
          operation.kind === "plan" && operation.work?.replay
            ? source.entries.map((entry) => readEntry(entry.sourceIndex))
            : undefined,
        metadata:
          operation.kind === "preflight"
            ? readSessionCompactionPreparation(database, request)
            : undefined,
      };
    },
  );
  const { source } = value;
  if (operation.kind === "plan") {
    const replay =
      value.replayEntries && operation.work?.replay
        ? await prepareNativeCompactionReplay(
            value.replayEntries,
            operation.work.replay,
            source.snapshotState,
          )
        : undefined;
    control.throwIfCancelled();
    const planned = value.planned && { ...value.planned, ...replay };
    if (!planned) {
      throw new Error("Compaction plan is missing");
    }
    if (planned.status === "skipped") {
      return { kind: "compaction-preparation", source, reads, ...planned };
    }
    return {
      kind: "compaction-preparation",
      source,
      reads,
      ...planned,
      preparation: planned.plan.preparation,
      selections: planned.plan.selections,
    };
  }
  const prepared = prepareCompactionEntryFacts(source.entries, {
    enabled: true,
    reserveTokens: 0,
    keepRecentTokens: 0,
  });
  if (!prepared.ok) {
    throw prepared.error;
  }
  if (operation.kind === "preflight") {
    if (!value.metadata) {
      throw new Error("Compaction preflight metadata is missing");
    }
    return {
      kind: "compaction-preparation",
      status: "preflight",
      ...value.metadata,
      source,
      ...(prepared.value
        ? {}
        : {
            reason:
              source.entries.at(-1)?.type === "compaction"
                ? "Already compacted"
                : "Nothing to compact (session too small)",
          }),
      reads,
    };
  }
  throw new Error("Unknown compaction operation");
}
