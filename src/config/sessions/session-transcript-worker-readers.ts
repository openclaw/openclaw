import { err, ok } from "@openclaw/normalization-core/result";
import type { WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import type { SessionTranscriptHydrationChunk } from "./session-transcript-hydration.types.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerDatabase,
  type SessionHistoryWorkerPreparedInput,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type SessionHistoryWorkerRequestRunner = <
  Kind extends SessionHistoryWorkerPreparedInput["kind"],
  TResult,
>(
  prepare: () => Extract<SessionHistoryWorkerPreparedInput, { kind: Kind }>,
  inputBytes: number,
  receive: (value: SessionTranscriptWorkerValues[Kind]) => TResult,
  signal?: AbortSignal,
  onRequest?: (value: unknown, signal: AbortSignal) => void | Promise<WorkerTaskResponse>,
  timeoutMs?: number,
) => Promise<TResult>;

type Readers = Omit<SessionHistoryWorkerDatabase, "assertCurrent">;
type ReaderContext = { runRequest: SessionHistoryWorkerRequestRunner };

/** Share stateless methods; each retained read keeps its own admission runner. */
export function createSessionHistoryWorkerReaders(
  runRequest: SessionHistoryWorkerRequestRunner,
): Readers {
  return Object.assign({ runRequest }, readers);
}

function reader<K extends SessionHistoryWorkerPreparedInput["kind"], T>(
  kind: K,
  project: (value: SessionTranscriptWorkerValues[K]) => T,
): (
  input: Omit<Extract<SessionHistoryWorkerPreparedInput, { kind: K }>, "kind">,
  signal?: AbortSignal,
) => Promise<T>;
function reader<K extends SessionHistoryWorkerPreparedInput["kind"], Input extends object, T>(
  kind: K,
  project: (value: SessionTranscriptWorkerValues[K]) => T,
  prepare: (input: Input) => Extract<SessionHistoryWorkerPreparedInput, { kind: K }>,
): (input: Input, signal?: AbortSignal) => Promise<T>;
function reader<K extends SessionHistoryWorkerPreparedInput["kind"], Input extends object, T>(
  kind: K,
  project: (value: SessionTranscriptWorkerValues[K]) => T,
  prepare?: (input: Input) => Extract<SessionHistoryWorkerPreparedInput, { kind: K }>,
): (input: Input, signal?: AbortSignal) => Promise<T> {
  return async function (this: ReaderContext, input, signal) {
    return this.runRequest(
      () => {
        const request =
          prepare?.(input) ??
          // SAFETY: The direct overload checks kind/input pairing; spread loses that correlation.
          ({ kind, ...input } as Extract<SessionHistoryWorkerPreparedInput, { kind: K }>);
        // Windows environments can be Proxies; only plain snapshots cross the worker boundary.
        if ("scope" in request && request.scope.env) {
          return { ...request, scope: { ...request.scope, env: { ...request.scope.env } } };
        }
        return "env" in request && request.env ? { ...request, env: { ...request.env } } : request;
      },
      JSON.stringify(input).length * 2,
      project,
      signal,
    );
  };
}
const readers: Readers & ThisType<ReaderContext> = {
  readTrajectoryEvents: reader("trajectory-events", (value) => value.events),
  readTrajectoryRetention(input, options) {
    const captured = {
      ...input,
      input: { ...input.input },
      expectedIdentity: { ...input.expectedIdentity },
      env: captureSessionTranscriptStorageEnvironment(input.env),
    };
    return this.runRequest(
      () => ({ kind: "trajectory-retention", ...captured }),
      JSON.stringify(captured).length * 2,
      (value) => value.plan,
      options.signal,
      undefined,
      options.timeoutMs,
    );
  },
  readCleanup: reader("session-cleanup", (value) => value),
  readRawDelta: reader("transcript-raw-delta", (value) => value.result),
  readLatestAssistant: reader("transcript-latest-assistant", (value) => value.result),
  readVisibleDelta: reader("transcript-visible-delta", (value) => value.result),
  readSessionMemoryCapture: reader("session-memory-capture", (value) => value.result),
  readBoardSnapshot: reader("board-snapshot", (result) => result.value),
  readBoardWidgetDocument: reader("board-widget-document", (result) => result.value),
  readBranchSummaries: reader("branch-summaries", (value) => value.result),
  readMessagePresence: reader("transcript-message-presence", (value) => value.present),
  readAnchors: reader("transcript-anchors", (value) => value.facts),
  readRuntimeTarget: reader("session-runtime-target", (value) => value.target),
  readConversations: reader("conversation-rows", (value) => value.rows),
  readConversationBindings: reader("conversation-bindings", (value) => value.snapshot),
  prewarm: reader("prewarm", () => undefined),
  readRetirement: reader("session-retirement-read", (value) => value.result),
  readPendingArchives: reader("session-pending-archives", (value) => value.pending),
  readLifecycleArtifactPlan: reader("lifecycle-artifact-plan", (value) => value),
  readTranscriptStatsBatch: reader("transcript-stats-batch", (value) => value.stats),
  readTranscriptInstances: reader(
    "session-transcript-instances",
    (value) => value.instances,
    (input) => ({
      kind: "session-transcript-instances",
      ...input,
      scope: {
        ...input.scope,
        env: captureSessionTranscriptStorageEnvironment(input.scope.env ?? process.env),
      },
    }),
  ),
  readMemorySessionTargets: reader(
    "memory-session-targets",
    (value) => value.targets,
    (input) => ({
      kind: "memory-session-targets",
      ...input,
      params: {
        ...input.params,
        env: captureSessionTranscriptStorageEnvironment(input.params.env),
      },
    }),
  ),
  readArchiveInventory: reader(
    "session-archive-inventory",
    (value) => value.archives,
    (input) => ({
      kind: "session-archive-inventory",
      ...input,
      env: captureSessionTranscriptStorageEnvironment(input.env ?? process.env),
    }),
  ),
  readCorpusInventory: reader(
    "session-corpus-inventory",
    (value) => value.entries,
    (input) => ({
      kind: "session-corpus-inventory",
      ...input,
      scope: { ...input.scope, env: captureSessionTranscriptStorageEnvironment(input.scope.env) },
    }),
  ),
  readArchivePresence: reader("session-archive-presence", (value) => value.registered),
  findTranscriptEvent: reader(
    "transcript-match",
    (value) => value.result,
    (request) => ({ kind: "transcript-match", request }),
  ),
  readHistoricalEvictionCandidates: reader(
    "historical-eviction-candidates",
    (value) => {
      if (!("sessionIds" in value)) {
        throw new Error(
          "Session history worker returned archived instead of historical candidates",
        );
      }
      return value.sessionIds;
    },
    (input) => ({ kind: "historical-eviction-candidates", ...input }),
  ),
  readArchivedEvictionCandidates: reader(
    "historical-eviction-candidates",
    (value) => {
      if (!("batch" in value)) {
        throw new Error(
          "Session history worker returned historical instead of archived candidates",
        );
      }
      return value.batch;
    },
    (input) => ({ kind: "historical-eviction-candidates", ...input }),
  ),
  readArchivePruning: reader("session-archive-pruning", (value) => value.result),
  readColdMetadata: reader("cold-metadata", (value) => value),
  readColdStorageInventory: reader("cold-storage-inventory", (value) => value),
  searchTranscripts(params, readIndexStatus) {
    return this.runRequest(
      () => ({ kind: "transcript-search", params }),
      JSON.stringify(params).length * 2,
      (value) => value.result,
      undefined,
      async (request, signal) => {
        if (request !== "transcript-index-status") {
          throw new Error("Unexpected transcript search status request");
        }
        return { input: await readIndexStatus(signal), timeoutMs: 60_000 };
      },
    );
  },
  readPreview: reader("session-preview", (value) => value.items),
  readTitleFields: reader("session-title-fields", (value) => value.fields),
  readWatermark: reader("transcript-watermark", (value) => value.watermark),
  readStats: reader("transcript-stats", (value) => value.stats),
  readActivitySummarySource: reader("session-activity-summary-source", (value) => value.source),
  async run(prepare, inputBytes) {
    return this.runRequest(prepare, inputBytes, (value) => value);
  },
  async readTranscript(input, signal) {
    const events: TranscriptEvent[] = [];
    const eventJson: string[] | undefined = input.includeEventJson ? [] : undefined;
    const eventSeqs: number[] | undefined = input.includeEventJson ? [] : undefined;
    const parts: Uint8Array[] = [];
    let decoder: TextDecoder | undefined;
    const receiveChunk = (raw: unknown) => {
      // SAFETY: The paired local hydration worker constructs this typed envelope.
      const value = raw as SessionTranscriptHydrationChunk;
      // The worker holds one storage encoding for the entire read snapshot.
      decoder ??= new TextDecoder(value.encoding, { ignoreBOM: true });
      for (const frame of value.frames) {
        parts.push(frame.data);
        if (frame.endOfEvent) {
          const json = decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts));
          events.push(JSON.parse(json));
          eventJson?.push(json);
          if (eventSeqs) {
            if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq)) {
              throw new Error("Transcript snapshot omitted its row sequence");
            }
            eventSeqs.push(frame.seq);
          }
          parts.length = 0;
        }
      }
    };
    return await this.runRequest(
      () => ({ kind: "transcript-hydration", ...input }),
      JSON.stringify(input).length * 2,
      (value) => {
        if (value.kind === "bounded") {
          return value;
        }
        if (parts.length !== 0 || events.length !== value.eventCount) {
          throw new Error("Session history worker returned an incomplete transcript");
        }
        return {
          kind: "full",
          snapshot: {
            events,
            version: value.version,
            ...(eventJson ? { eventJson, eventSeqs } : {}),
          },
        };
      },
      signal,
      input.limits ? undefined : receiveChunk,
    );
  },
  readMaintenance: reader("transcript-maintenance", (value) => value),
  readCurrentTurnEntry: reader("current-turn-entry", (value) => value),
  readRecentActiveEvents: reader("recent-active-events", (value) => value.events),
  readLatestActiveMessage: reader("latest-active-message", (value) => value.message),
  readVoiceSessions: reader("voice-sessions", (value) => value),
  readMembershipFacts: reader("session-membership-facts", (value) => value),
  readMembers: reader("session-members", (value) => value),
  readSuggestions: reader("session-suggestions", (value) => value.suggestions),
  readReactions: reader("session-reactions", (value) => value.reactions),
  async readExactEntries(input, signal) {
    const captured = { ...input, env: captureSessionTranscriptStorageEnvironment(input.env) };
    return this.runRequest(
      () => ({ kind: "session-exact-entries", ...captured }),
      JSON.stringify(captured).length * 2,
      (value) => value,
      signal,
    );
  },
  async readRowFacts(input) {
    if (input.sessionKeys.length > MAX_SESSION_ROW_FACTS_KEYS) {
      throw new Error(`Session row facts support at most ${MAX_SESSION_ROW_FACTS_KEYS} keys`);
    }
    const captured = {
      env: captureSessionTranscriptStorageEnvironment(input.env),
      sessionKeys: [...input.sessionKeys],
      continuation: input.continuation ? { ...input.continuation } : undefined,
    };
    return await this.runRequest(
      () => ({ kind: "session-row-facts", ...captured }),
      JSON.stringify(captured).length * 2,
      (value) => value,
    );
  },
  readProgressCard: reader("session-progress-card", (value) => value.card),
  readPendingInputHistory: reader("session-pending-input-history", (value) => value.snapshot),
  readPendingInputReceipts: reader("session-pending-input-receipts", (value) => value.receipts),
  readHarnessCompletionSource: reader(
    "session-harness-completion-source",
    (value) => value.snapshot,
  ),
  readPendingInputSource: reader("session-pending-input-source", (value) => value.snapshot),
  readConversationDelivery: reader("conversation-delivery", (value) => value.record),
  readGoalOperationReceipt: reader("goal-operation-receipt", (value) => value.result),
  readEntryResult: reader("session-entry-read", (value) => ({
    ...(value.readError
      ? err(decodeSessionTranscriptWorkerReadError(value.readError))
      : ok(value.entry)),
    source: value.source,
    facts: value.facts,
  })),
  readEntryCurrent: reader("session-entry-current", (value) => value.entry),
  // The native reader validates the selected file. Replacement after that read is best effort.
  async readEntries(scope, continuation, expectedIdentity, ifRevision) {
    const captured = expectedIdentity && { ...expectedIdentity };
    return this.runRequest(
      () => ({
        kind: "session-entry-list",
        scope,
        continuation,
        expectedIdentity: captured,
        ifRevision,
      }),
      JSON.stringify({ scope, continuation, expectedIdentity: captured, ifRevision }).length * 2,
      (value) => value,
    );
  },
  readStoreProjection: reader("session-store-projection", (value) => value),
  readStoreSummary: reader("session-store-summary", (value) => value.summary),
  readIdentityEvidence: reader("session-identity-evidence", (value) => value.evidence),
  readProjectionStatus: reader("projection-status", (value) => value),
  readEntryPresence: reader(
    "session-row-presence",
    (value) => value,
    (scope) => ({ kind: "session-row-presence", scope }),
  ),
};
