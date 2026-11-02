import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { CombinedSessionStoreTopologyRequest } from "./combined-store.types.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import {
  measureSessionStoreTargetInventoryInputBytes,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import type {
  SessionStoreTargetReadRequest,
  SessionStoreTargetReadResult,
  SessionStoreTargetInventoryRequest,
} from "./session-store-target-inventory.js";
import type { SessionTranscriptHydrationChunk } from "./session-transcript-hydration.types.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerInput,
  type SessionHistoryWorkerDatabase,
  type SessionHistoryWorkerPreparedInput,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { InternalSessionEntry } from "./types.js";

export type SessionHistoryWorkerRequestRunner = <
  Request extends SessionHistoryWorkerPreparedInput,
  TResult,
>(
  prepare: () => Request,
  inputBytes: number,
  receive: (value: SessionTranscriptWorkerValues[Request["kind"]]) => TResult,
  signal?: AbortSignal,
  onRequest?: (value: unknown, signal: AbortSignal) => void | Promise<WorkerTaskResponse>,
  timeoutMs?: number,
) => Promise<TResult>;

type Readers = Omit<SessionHistoryWorkerDatabase, "assertCurrent">;
type ReaderContext = { runRequest: SessionHistoryWorkerRequestRunner };

// JSON and worker transport copy primitive strings. Reuse equal identities only after
// transport, while the received graph is still owned here; mismatched evidence stays intact.
function shareSummaryIdentityStrings(entry: InternalSessionEntry | undefined, key?: string) {
  if (!entry) {
    return entry;
  }
  const digest = entry.observerDigest;
  if (!digest) {
    return entry;
  }
  const sessionKey = key ?? digest.sessionKey;
  if (digest.sessionId === entry.sessionId) {
    digest.sessionId = entry.sessionId;
  }
  if (
    digest.lifecycleRevision !== undefined &&
    digest.lifecycleRevision === entry.lifecycleRevision
  ) {
    digest.lifecycleRevision = entry.lifecycleRevision;
  }
  if (sessionKey !== undefined && digest.sessionKey === sessionKey) {
    digest.sessionKey = sessionKey;
  }
  if (digest.runId !== undefined && digest.runId === entry.lastRunId) {
    digest.runId = entry.lastRunId;
  }
  return entry;
}

function shareSummaryRowStrings<T extends { entries: SessionEntrySummary[] }>(value: T): T {
  for (const { entry, sessionKey } of value.entries) {
    shareSummaryIdentityStrings(entry, sessionKey);
  }
  return value;
}

/** Share stateless methods; each retained read keeps its own admission runner. */
export function createSessionHistoryWorkerReaders(
  runRequest: SessionHistoryWorkerRequestRunner,
): Readers {
  return Object.assign({ runRequest }, readers);
}

function reader<Input extends object, Request extends SessionHistoryWorkerPreparedInput, T>(
  prepare: (input: Input) => Request,
  project: (value: SessionTranscriptWorkerValues[Request["kind"]]) => T,
): (input: Input, signal?: AbortSignal) => Promise<T> {
  return async function (this: ReaderContext, input, signal) {
    return this.runRequest<Request, T>(
      () => {
        const request = prepare(input);
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
  readTrajectoryEvents: reader(
    (input) => ({ kind: "trajectory-events", ...input }),
    (value) => value.events,
  ),
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
  readCleanup: reader(
    (input) => ({ kind: "session-cleanup", ...input }),
    (value) => value,
  ),
  readRawDelta: reader(
    (input) => ({ kind: "transcript-raw-delta", ...input }),
    (value) => value.result,
  ),
  readLatestAssistant: reader(
    (input) => ({ kind: "transcript-latest-assistant", ...input }),
    (value) => value.result,
  ),
  readVisibleDelta: reader(
    (input) => ({ kind: "transcript-visible-delta", ...input }),
    (value) => value.result,
  ),
  readSessionMemoryCapture: reader(
    (input) => ({ kind: "session-memory-capture", ...input }),
    (value) => value.result,
  ),
  readBoardSnapshot: reader(
    (input) => ({ kind: "board-snapshot", ...input }),
    (result) => result.value,
  ),
  readBoardWidgetDocument: reader(
    (input) => ({ kind: "board-widget-document", ...input }),
    (result) => result.value,
  ),
  readBranchSummaries: reader(
    (input) => ({ kind: "branch-summaries", ...input }),
    (value) => value.result,
  ),
  readMessagePresence: reader(
    (input) => ({ kind: "transcript-message-presence", ...input }),
    (value) => value.present,
  ),
  readAnchors: reader(
    (input) => ({ kind: "transcript-anchors", ...input }),
    (value) => value.facts,
  ),
  readRuntimeTarget: reader(
    (input) => ({ kind: "session-runtime-target", ...input }),
    (value) => value.target,
  ),
  readConversations: reader(
    (input) => ({ kind: "conversation-rows", ...input }),
    (value) => value.rows,
  ),
  readConversationBindings: reader(
    (input) => ({ kind: "conversation-bindings", ...input }),
    (value) => value.snapshot,
  ),
  prewarm: reader(
    (input) => ({ kind: "prewarm", ...input }),
    () => undefined,
  ),
  readRetirement: reader(
    (input) => ({ kind: "session-retirement-read", ...input }),
    (value) => value.result,
  ),
  readPendingArchives: reader(
    (input) => ({ kind: "session-pending-archives", ...input }),
    (value) => value.pending,
  ),
  readLifecycleArtifactPlan: reader(
    (input) => ({ kind: "lifecycle-artifact-plan", ...input }),
    (value) => value,
  ),
  readTranscriptStatsBatch: reader(
    (input) => ({ kind: "transcript-stats-batch", ...input }),
    (value) => value.stats,
  ),
  readTranscriptInstances: reader(
    (input) => ({
      kind: "session-transcript-instances",
      ...input,
      scope: {
        ...input.scope,
        env: captureSessionTranscriptStorageEnvironment(input.scope.env ?? process.env),
      },
    }),
    (value) => value.instances,
  ),
  readMemorySessionTargets: reader(
    (input) => ({
      kind: "memory-session-targets",
      ...input,
      params: {
        ...input.params,
        env: captureSessionTranscriptStorageEnvironment(input.params.env),
      },
    }),
    (value) => value.targets,
  ),
  readArchiveInventory: reader(
    (input) => ({
      kind: "session-archive-inventory",
      ...input,
      env: captureSessionTranscriptStorageEnvironment(input.env ?? process.env),
    }),
    (value) => value.archives,
  ),
  readCorpusInventory: reader(
    (input) => ({
      kind: "session-corpus-inventory",
      ...input,
      scope: { ...input.scope, env: captureSessionTranscriptStorageEnvironment(input.scope.env) },
    }),
    (value) => value.entries,
  ),
  readArchivePresence: reader(
    (input) => ({ kind: "session-archive-presence", ...input }),
    (value) => value.registered,
  ),
  findTranscriptEvent: reader(
    (request) => ({ kind: "transcript-match", request }),
    (value) => value.result,
  ),
  readHistoricalEvictionCandidates: reader(
    (input) => ({ kind: "historical-eviction-candidates", ...input }),
    (value) => {
      if (!("sessionIds" in value)) {
        throw new Error(
          "Session history worker returned archived instead of historical candidates",
        );
      }
      return value.sessionIds;
    },
  ),
  readArchivedEvictionCandidates: reader(
    (input) => ({ kind: "historical-eviction-candidates", ...input }),
    (value) => {
      if (!("batch" in value)) {
        throw new Error(
          "Session history worker returned historical instead of archived candidates",
        );
      }
      return value.batch;
    },
  ),
  readArchivePruning: reader(
    (input) => ({ kind: "session-archive-pruning", ...input }),
    (value) => value.result,
  ),
  readColdMetadata: reader(
    (input) => ({ kind: "cold-metadata", ...input }),
    (value) => value,
  ),
  readColdStorageInventory: reader(
    (input) => ({ kind: "cold-storage-inventory", ...input }),
    (value) => value,
  ),
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
  readPreview: reader(
    (input) => ({ kind: "session-preview", ...input }),
    (value) => value.items,
  ),
  readTitleFields: reader(
    (input) => ({ kind: "session-title-fields", ...input }),
    (value) => value.fields,
  ),
  readWatermark: reader(
    (input) => ({ kind: "transcript-watermark", ...input }),
    (value) => value.watermark,
  ),
  readStats: reader(
    (input) => ({ kind: "transcript-stats", ...input }),
    (value) => value.stats,
  ),
  readActivitySummarySource: reader(
    (input) => ({ kind: "session-activity-summary-source", ...input }),
    (value) => value.source,
  ),
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
  readMaintenance: reader(
    (input) => ({ kind: "transcript-maintenance", ...input }),
    (value) => value,
  ),
  readCurrentTurnEntry: reader(
    (input) => ({ kind: "current-turn-entry", ...input }),
    (value) => value,
  ),
  readRecentActiveEvents: reader(
    (input) => ({ kind: "recent-active-events", ...input }),
    (value) => value.events,
  ),
  readLatestActiveMessage: reader(
    (input) => ({ kind: "latest-active-message", ...input }),
    (value) => value.message,
  ),
  readVoiceSessions: reader(
    (input) => ({ kind: "voice-sessions", ...input }),
    (value) => value,
  ),
  readMembershipFacts: reader(
    (input) => ({ kind: "session-membership-facts", ...input }),
    (value) => value,
  ),
  readMembers: reader(
    (input) => ({ kind: "session-members", ...input }),
    (value) => value,
  ),
  readSuggestions: reader(
    (input) => ({ kind: "session-suggestions", ...input }),
    (value) => value.suggestions,
  ),
  readReactions: reader(
    (input) => ({ kind: "session-reactions", ...input }),
    (value) => value.reactions,
  ),
  async readExactEntries(input, signal) {
    const captured = { ...input, env: captureSessionTranscriptStorageEnvironment(input.env) };
    return this.runRequest(
      () => ({ kind: "session-exact-entries", ...captured }),
      JSON.stringify(captured).length * 2,
      shareSummaryRowStrings,
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
      (value) => {
        for (const { entry, sessionKey } of value.rows) {
          shareSummaryIdentityStrings(entry, sessionKey);
        }
        return value;
      },
    );
  },
  readProgressCard: reader(
    (input) => ({ kind: "session-progress-card", ...input }),
    (value) => value.card,
  ),
  readPendingInputHistory: reader(
    (input) => ({ kind: "session-pending-input-history", ...input }),
    (value) => value.snapshot,
  ),
  readPendingInputOrphans: reader(
    (input) => ({ kind: "session-pending-input-orphans", ...input }),
    (value) => value.targets,
  ),
  readPendingInputReceipts: reader(
    (input) => ({ kind: "session-pending-input-receipts", ...input }),
    (value) => value.receipts,
  ),
  readPendingInputSource: reader(
    (input) => ({ kind: "session-pending-input-source", ...input }),
    (value) => value.snapshot,
  ),
  readConversationDelivery: reader(
    (input) => ({ kind: "conversation-delivery", ...input }),
    (value) => value.record,
  ),
  readGoalOperationReceipt: reader(
    (input) => ({ kind: "goal-operation-receipt", ...input }),
    (value) => value.result,
  ),
  readEntryResult: reader(
    (input) => ({ kind: "session-entry-read", ...input }),
    (value) => ({
      ...(value.readError
        ? err(decodeSessionTranscriptWorkerReadError(value.readError))
        : ok(shareSummaryIdentityStrings(value.entry))),
      source: value.source,
      facts: value.facts && shareSummaryRowStrings(value.facts),
    }),
  ),
  readEntryCurrent: reader(
    (input) => ({ kind: "session-entry-current", ...input }),
    (value) => value.entry,
  ),
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
      shareSummaryRowStrings,
    );
  },
  readStoreProjection: reader(
    (input) => ({ kind: "session-store-projection", ...input }),
    shareSummaryRowStrings,
  ),
  readStoreSummary: reader(
    (input) => ({ kind: "session-store-summary", ...input }),
    (value) => value.summary,
  ),
  readIdentityEvidence: reader(
    (input) => ({ kind: "session-identity-evidence", ...input }),
    (value) => value.evidence,
  ),
  readProjectionStatus: reader(
    (input) => ({ kind: "projection-status", ...input }),
    (value) => value,
  ),
  readEntryPresence: reader(
    (scope) => ({ kind: "session-row-presence", scope }),
    (value) => value,
  ),
};

// Discovery uses routing settings; model and plugin config stays with host consumers.
export function sessionDiscoveryConfig({ agents, acp, session }: OpenClawConfig) {
  return { agents, acp, session };
}

export function createSessionStoreTargetReaders(
  capturedCandidates: SessionStoreReadCandidate[],
  runRead: <
    Input extends Extract<
      SessionHistoryWorkerInput,
      { kind: "session-store-target" | "session-target-inventory" | "combined-store-topology" }
    >,
  >(
    input: Input,
    inputBytes: number,
  ) => Promise<SessionTranscriptWorkerValues[Input["kind"]]>,
  settleCandidates: () => Promise<void>,
) {
  const readStoreTargetResult = async (
    request: Omit<SessionStoreTargetReadRequest, "candidates">,
  ): Promise<Result<SessionStoreTargetReadResult, unknown>> => {
    const preparedRequest = {
      ...request,
      env: captureSessionTranscriptStorageEnvironment(request.env),
      candidates: capturedCandidates,
    };
    const result = await runRead(
      { kind: "session-store-target", request: preparedRequest },
      JSON.stringify(preparedRequest).length * 2,
    );
    return "readError" in result
      ? err(decodeSessionTranscriptWorkerReadError(result.readError))
      : ok(result);
  };
  return {
    readCombinedTopology: async (
      request: Omit<CombinedSessionStoreTopologyRequest, "candidates">,
    ) => {
      const preparedRequest = {
        ...request,
        config: sessionDiscoveryConfig(request.config),
        options: {
          ...request.options,
          discovery: {
            ...request.options.discovery,
            env: captureSessionTranscriptStorageEnvironment(request.options.discovery.env),
          },
        },
        candidates: capturedCandidates,
      };
      return await runRead(
        { kind: "combined-store-topology", request: preparedRequest },
        JSON.stringify(preparedRequest).length * 2,
      );
    },
    readStoreTargetResult,
    readStoreTarget: async (request: Omit<SessionStoreTargetReadRequest, "candidates">) => {
      const read = await readStoreTargetResult(request);
      if (!read.ok) {
        throw read.error;
      }
      return read.value;
    },
    readTargetInventory: async (
      request: Omit<SessionStoreTargetInventoryRequest, "candidates">,
    ) => {
      const preparedRequest = {
        ...request,
        config: sessionDiscoveryConfig(request.config),
        env: captureSessionTranscriptStorageEnvironment(request.env),
        candidates: capturedCandidates,
      };
      const result = await runRead(
        { kind: "session-target-inventory", request: preparedRequest },
        measureSessionStoreTargetInventoryInputBytes(preparedRequest),
      );
      if (result.kind === "session-target-registry-required") {
        // Release native readers before registry work without discarding a healthy worker.
        await settleCandidates();
      }
      return result;
    },
  };
}
