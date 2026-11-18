import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { prepareCompactionEntryFacts } from "../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import { estimateContextTokens } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { iterateSessionContextEntryFacts } from "../../../packages/agent-core/src/harness/session/session.js";
import { sanitizeCompactionReplayMessages } from "../../agents/compaction-replay.js";
import {
  collectExactReplaySourceFact,
  resolveExactReplaySourcePolicy,
  collectExactReplayMediaFacts,
  compareExactReplayRows,
  prepareExactCompactionReplay,
} from "../../agents/embedded-agent-runner/exact-compaction-replay.js";
import {
  collectPreparedCompactionEntryFact,
  prepareCompactionPlan,
  readPreparedCompactionMessage,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.js";
import type {
  PreparedCompactionEntryFact,
  PreparedCompactionMessageSource,
} from "../../agents/embedded-agent-runner/prepared-compaction-plan.types.js";
import { prepareCompactionReplay } from "../../agents/embedded-agent-runner/prepared-compaction-replay.js";
import {
  isSameModelSnapshot,
  readModelSnapshotStateFromEntries,
  MODEL_SNAPSHOT_CUSTOM_TYPE,
} from "../../agents/embedded-agent-runner/replay-model-snapshot.js";
import { createCompactionReplacementProjector } from "../../agents/sessions/compaction/preparation.js";
import { estimateCompactedRequestTokens } from "../../agents/sessions/compaction/request-budget.js";
import type { SessionEntry, SessionHeader } from "../../agents/sessions/session-manager-types.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { readSessionTranscriptCompactionPlan } from "./session-accessor.sqlite-active-context.js";
import { validateSessionTranscriptContextInDatabase } from "./session-accessor.sqlite-model-context.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type {
  PreparedCompactionSource,
  SessionPreparedCompactionInput,
  SessionPreparedCompactionWireValue,
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

/** One extraction pass; no model, credential, writer, or resident worker across inference. */
export async function readPreparedSessionCompaction(
  request: SessionPreparedCompactionInput,
  control: WorkerTaskControl,
): Promise<SessionPreparedCompactionWireValue> {
  const { operation } = request;
  if (operation.kind === "render") {
    const { value: conversation, reads } = await renderPreparedSessionCompaction(
      { ...request, operation },
      control,
    );
    return { kind: "compaction-preparation", status: "rendered", conversation, reads };
  }
  if (operation.kind === "finalize") {
    const { value: finalizedSource, reads } = await withCompactionSourceRows(
      request,
      control,
      ({ database, readEntry, readEntriesAfter }) => ({
        // Prefix validation admits only an active-path suffix; planned dependencies remain retained.
        retained: [
          ...operation.retainedSequences.map(readEntry),
          ...readEntriesAfter(operation.version.rawSeq ?? 0),
        ],
        transcriptMutationAt: readTranscriptContextVersionInTransaction(
          database,
          request.resolvedScope.sessionId,
        ).updatedAt,
      }),
    );
    const { retained, transcriptMutationAt } = finalizedSource;
    const first = retained.findIndex((entry) => entry.id === operation.summary.firstKeptEntryId);
    const pending = operation.work.pendingEntryId;
    if (
      pending !== undefined &&
      (first < 0 || first > retained.findIndex((entry) => entry.id === pending))
    ) {
      throw new Error("Compaction must retain the unprocessed pending user request.");
    }
    const replacement = createCompactionReplacementProjector(retained, operation.work.itemId)(
      operation.summary,
      operation.summary.summary,
    );
    const budget = operation.work.requestBudget;
    if (
      budget &&
      operation.work.requestTokenLimit !== undefined &&
      estimateCompactedRequestTokens(replacement, budget) > operation.work.requestTokenLimit
    ) {
      throw new Error(
        "The finalized compaction exceeds the foreground request budget. Reduce the request or select a larger context window.",
      );
    }
    const messages = sanitizeCompactionReplayMessages(replacement);
    const tokensAfter = budget
      ? estimateCompactedRequestTokens(messages, { ...budget, pendingTokens: 0 })
      : estimateContextTokens(messages).tokens;
    const replay = await prepareCompactionReplay(retained, operation.replay, messages);
    control.throwIfCancelled();
    return {
      kind: "compaction-preparation",
      status: "finalized",
      transcriptMutationAt,
      tokensAfter,
      messageCountAfter: messages.length,
      retainedReplayMetrics: replay.beforeHookMetrics,
      reads,
    };
  }
  const { value: captured, reads } = await withCompactionSourceRows(
    request,
    control,
    ({ database, reads: extracted }) => {
      let source: PreparedCompactionSource;
      if (operation.kind === "plan" && operation.source) {
        source = operation.source;
        if (source.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, source.expectedIdentity);
        }
        validateSessionTranscriptContextInDatabase(database, request.resolvedScope, {
          version: source.version,
          admission: request.admission,
        });
      } else {
        const facts = new Map<number, PreparedCompactionEntryFact>();
        let header: SessionHeader | undefined;
        let selected: number[] = [];
        const snapshot = readSessionTranscriptCompactionPlan(request.target, {
          compaction: true,
          readOnly: true,
          resolvedScope: request.resolvedScope,
          transaction: database,
          onEntry: (event, row) => {
            control.throwIfCancelled();
            extracted.extractedRows += 1;
            extracted.extractedBytes += row.serializedBytes;
            if (isIndexedSessionEntry(event)) {
              facts.set(
                row.rawSeq,
                collectPreparedCompactionEntryFact(
                  event,
                  row.rawSeq,
                  operation.kind === "plan" ? operation.replay : undefined,
                ),
              );
            } else {
              header ??= findSessionTranscriptHeader([event]);
            }
          },
          onRead: (_projection, rows) => {
            selected = rows.map((row) => row.rawSeq);
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
              .find((value) => value !== undefined) ?? id,
          );
        }
        const entries = readSessionEntryBranch(snapshot.activeLeafEntryId, (id) => {
          const entry = byId.get(id);
          if (!entry) {
            return { parentId: snapshot.opaqueParents.get(id) ?? null };
          }
          const parent = snapshot.parents.has(id) ? snapshot.parents.get(id)! : entry.parentId;
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
          header,
          expectedIdentity: request.expectedIdentity,
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
        preparation:
          operation.kind === "preflight"
            ? readSessionCompactionPreparation(database, request)
            : undefined,
      };
    },
  );
  const { source } = captured;
  if (operation.kind === "preflight") {
    const prepared = prepareCompactionEntryFacts(source.entries, {
      enabled: true,
      reserveTokens: 0,
      keepRecentTokens: 0,
    });
    // Malformed preparation still reaches the normal execution error owner.
    const reason =
      prepared.ok && !prepared.value
        ? source.entries.at(-1)?.type === "compaction"
          ? ("Already compacted" as const)
          : ("Nothing to compact (session too small)" as const)
        : undefined;
    return {
      kind: "compaction-preparation",
      status: "preflight",
      ...captured.preparation!,
      source,
      eventCount: source.eventCount,
      reason,
      reads,
    };
  }
  const selectedRead = async <T>(consume: (readEntry: (seq: number) => SessionEntry) => T) => {
    const selected = await withCompactionSourceRows(
      request,
      control,
      ({ readEntry }) => consume(readEntry),
      source.version,
    );
    reads.selectedRows += selected.reads.selectedRows;
    reads.selectedBytes += selected.reads.selectedBytes;
    return selected.value;
  };
  const readProjected = async (locator: PreparedCompactionMessageSource) => {
    const message = await selectedRead((readEntry) =>
      readPreparedCompactionMessage(locator, readEntry),
    );
    if (!message) {
      throw new Error("Exact replay source no longer contains its projected message");
    }
    return message;
  };
  const facts = [];
  for (const { entry, context } of iterateSessionContextEntryFacts(source.entries)) {
    const fact = entry.contextReplay[context];
    if (!fact) {
      continue;
    }
    // Only provider-owned envelopes need the selected model to validate their opaque state.
    facts.push(
      fact.deferredCheckpoint
        ? collectExactReplaySourceFact(
            await readProjected(fact.source),
            fact.source,
            operation.replay,
          )
        : resolveExactReplaySourcePolicy(fact, operation.replay),
    );
  }
  const snapshot = readModelSnapshotStateFromEntries(
    source.entries.map((entry) => ({
      type: "custom",
      customType: MODEL_SNAPSHOT_CUSTOM_TYPE,
      data: entry.markers.modelSnapshot,
    })),
  );
  const model = operation.replay.model;
  const latestModelSwitchTimestamp =
    snapshot.lastSnapshot &&
    !isSameModelSnapshot(snapshot.lastSnapshot, {
      timestamp: 0,
      provider: model.provider,
      modelApi: model.api,
      modelId: model.id,
    })
      ? Date.now()
      : snapshot.latestSwitchTimestamp;
  const replay = await prepareExactCompactionReplay(
    facts,
    operation.replay,
    {
      latestModelSwitchTimestamp,
      builtinGoogleReplay: operation.replay.builtinGoogleReplay ?? false,
      googleMarkerPresent: source.entries.some((entry) => entry.markers.googleTurnOrdering),
    },
    {
      readMedia: async (locator, indexes) =>
        collectExactReplayMediaFacts(
          await readProjected(locator),
          locator,
          indexes,
          operation.replay,
        ),
      compareRows: (comparison) => compareExactReplayRows(comparison, readProjected),
    },
  );
  const metadata = {
    hasThinkingEntry: source.entries.some((entry) => entry.markers.thinkingLevel !== undefined),
    modelSnapshot: snapshot.lastSnapshot ?? undefined,
    needsGoogleTurnOrderingMarker: replay.needsGoogleTurnOrderingMarker,
  };
  if (!replay.hasRealConversation) {
    return {
      kind: "compaction-preparation",
      status: "skipped",
      reason: "no real conversation messages",
      beforeHookMetrics: replay.beforeHookMetrics,
      ...metadata,
      reads,
    };
  }
  if (!source.header) {
    throw new Error("Compaction source is missing its session header");
  }
  const plan = await selectedRead((readEntry) =>
    prepareCompactionPlan(source.entries, operation.options, { readEntry }),
  );
  if (plan.status === "skipped") {
    return {
      kind: "compaction-preparation",
      ...plan,
      beforeHookMetrics: replay.beforeHookMetrics,
      ...metadata,
      reads,
    };
  }
  control.throwIfCancelled();
  return {
    kind: "compaction-preparation",
    ...plan,
    header: source.header,
    version: source.version,
    leafEntryId: source.leafEntryId,
    boundaryCount: source.boundaryCount,
    persistedSuffixStartSeq: source.persistedSuffixStartSeq,
    transcriptMutationAt: source.transcriptMutationAt,
    ...replay,
    ...metadata,
    reads,
  };
}
