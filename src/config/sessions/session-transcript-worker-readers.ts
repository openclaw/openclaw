import { types } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
import type { WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionHistoryWorkerDatabase,
  type SessionHistoryWorkerInput,
  type SessionHistoryWorkerPreparedInput,
  type SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type SessionHistoryWorkerRequestRunner = <TResult>(
  prepare: () => SessionHistoryWorkerPreparedInput,
  inputBytes: number,
  receive: (value: SessionTranscriptWorkerValues[SessionHistoryWorkerInput["kind"]]) => TResult,
  signal?: AbortSignal,
  onRequest?: (value: unknown, signal: AbortSignal) => void | Promise<WorkerTaskResponse>,
  timeoutMs?: number,
) => Promise<TResult>;

type SessionHistoryWorkerValue = SessionTranscriptWorkerValues[SessionHistoryWorkerInput["kind"]];

function assertResultKind<K extends Extract<SessionHistoryWorkerValue, { kind: string }>["kind"]>(
  value: SessionHistoryWorkerValue,
  kind: K,
  expected: string,
): asserts value is Extract<SessionHistoryWorkerValue, { kind: K }> {
  if (typeof value === "boolean" || Array.isArray(value) || value.kind !== kind) {
    throw new Error(`Session history worker returned another result instead of ${expected}`);
  }
}

/** Decode domain results; database custody remains with the enclosing history owner. */
export function createSessionHistoryWorkerReaders(
  runRequest: SessionHistoryWorkerRequestRunner,
): Omit<SessionHistoryWorkerDatabase, "generation" | "assertCurrent"> {
  function reader<
    K extends Extract<SessionHistoryWorkerValue, { kind: string }>["kind"] &
      SessionHistoryWorkerPreparedInput["kind"],
    T,
  >(
    kind: K,
    expected: string,
    project: (value: Extract<SessionHistoryWorkerValue, { kind: K }>) => T,
  ): (
    input: Omit<Extract<SessionHistoryWorkerPreparedInput, { kind: K }>, "kind">,
    signal?: AbortSignal,
  ) => Promise<T>;
  function reader<
    K extends Extract<SessionHistoryWorkerValue, { kind: string }>["kind"],
    Input extends object,
    T,
  >(
    kind: K,
    expected: string,
    project: (value: Extract<SessionHistoryWorkerValue, { kind: K }>) => T,
    prepare: (input: Input) => SessionHistoryWorkerPreparedInput,
  ): (input: Input, signal?: AbortSignal) => Promise<T>;
  function reader<
    K extends Extract<SessionHistoryWorkerValue, { kind: string }>["kind"],
    Input extends object,
    T,
  >(
    kind: K,
    expected: string,
    project: (value: Extract<SessionHistoryWorkerValue, { kind: K }>) => T,
    prepare?: (input: Input) => SessionHistoryWorkerPreparedInput,
  ): (input: Input, signal?: AbortSignal) => Promise<T> {
    return async (input, signal) =>
      runRequest(
        () => {
          if (prepare) {
            return prepare(input);
          }
          // SAFETY: The direct overload checks kind/input pairing; spread loses that correlation.
          return { kind, ...input } as SessionHistoryWorkerPreparedInput;
        },
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, kind, expected);
          return project(value);
        },
        signal,
      );
  }
  return {
    readTrajectoryEvents: reader("trajectory-events", "trajectory events", (value) => value.events),
    readTrajectoryRetention: (input, options) => {
      const captured = {
        ...input,
        input: { ...input.input },
        expectedIdentity: { ...input.expectedIdentity },
        env: captureSessionTranscriptStorageEnvironment(input.env),
      };
      return runRequest(
        () => ({ kind: "trajectory-retention", ...captured }),
        JSON.stringify(captured).length * 2,
        (value) => {
          assertResultKind(value, "trajectory-retention", "trajectory retention");
          return value.plan;
        },
        options.signal,
        undefined,
        options.timeoutMs,
      );
    },
    readCleanup: reader("session-cleanup", "a cleanup snapshot", (value) => value),
    readRawDelta: reader("transcript-raw-delta", "raw transcript delta", (value) => value.result),
    readLatestAssistant: reader(
      "transcript-latest-assistant",
      "latest assistant text",
      (value) => value.result,
    ),
    readVisibleDelta: reader(
      "transcript-visible-delta",
      "visible transcript delta",
      (value) => value.result,
    ),
    readSessionMemoryCapture: reader(
      "session-memory-capture",
      "session Memory capture",
      (value) => value.result,
    ),
    readBoardSnapshot: reader("board-snapshot", "a Board snapshot", (result) => result.value),
    readBoardWidgetDocument: reader(
      "board-widget-document",
      "a Board document",
      (result) => result.value,
    ),
    readBranchSummaries: reader("branch-summaries", "branch summaries", (value) => value.result),
    readMessagePresence: reader(
      "transcript-message-presence",
      "message presence",
      (value) => value.present,
    ),
    readAnchors: reader("transcript-anchors", "transcript anchors", (value) => value.facts),
    readRuntimeTarget: reader(
      "session-runtime-target",
      "runtime transcript target",
      (value) => value.target,
    ),
    readConversations: reader("conversation-rows", "conversations", (value) => value.rows),
    prewarm: reader("prewarm", "prewarm acknowledgement", () => undefined),
    readRetirement: reader(
      "session-retirement-read",
      "session retirement facts",
      (value) => value.result,
    ),
    readPendingArchives: reader(
      "session-pending-archives",
      "pending archives",
      (value) => value.pending,
    ),
    readLifecycleArtifactPlan: reader(
      "lifecycle-artifact-plan",
      "lifecycle artifact plan",
      (value) => value,
    ),
    readMemorySessionTargets: reader(
      "memory-session-targets",
      "memory session targets",
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
      "archive inventory",
      (value) => value.archives,
      (input) => ({
        kind: "session-archive-inventory",
        ...input,
        env: captureSessionTranscriptStorageEnvironment(input.env ?? process.env),
      }),
    ),
    readCorpusInventory: reader(
      "session-corpus-inventory",
      "corpus inventory",
      (value) => value.entries,
      (input) => ({
        kind: "session-corpus-inventory",
        ...input,
        scope: { ...input.scope, env: captureSessionTranscriptStorageEnvironment(input.scope.env) },
      }),
    ),
    readArchivePresence: reader(
      "session-archive-presence",
      "archive presence",
      (value) => value.registered,
    ),
    findTranscriptEvent: reader(
      "transcript-match",
      "a transcript match",
      (value) => value.result,
      (request) => ({ kind: "transcript-match", request }),
    ),
    readHistoricalEvictionCandidates: reader(
      "historical-eviction-candidates",
      "eviction candidates",
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
      "archived eviction candidates",
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
    readArchivePruning: reader(
      "session-archive-pruning",
      "archive pruning",
      (value) => value.result,
    ),
    readColdMetadata: reader("cold-metadata", "cold metadata", (value) => value),
    readColdStorageInventory: reader(
      "cold-storage-inventory",
      "cold storage inventory",
      (value) => value,
    ),
    searchTranscripts: (params, readIndexStatus) =>
      runRequest(
        () => ({ kind: "transcript-search", params }),
        JSON.stringify(params).length * 2,
        (value) => {
          assertResultKind(value, "transcript-search", "search");
          return value.result;
        },
        undefined,
        async (request, signal) => {
          if (request !== "transcript-index-status") {
            throw new Error("Unexpected transcript search status request");
          }
          return { input: await readIndexStatus(signal), timeoutMs: 60_000 };
        },
      ),
    readPreview: reader("session-preview", "a preview", (value) => value.items),
    readTitleFields: reader("session-title-fields", "title fields", (value) => value.fields),
    readWatermark: reader(
      "transcript-watermark",
      "a transcript watermark",
      (value) => value.watermark,
    ),
    readActivitySummarySource: reader(
      "session-activity-summary-source",
      "an Activity recap source",
      (value) => value.source,
    ),
    readRowBackfill: reader(
      "session-row-backfill",
      "transcript fields",
      (value) => value.fields,
      (params) => ({ kind: "session-row-backfill", params }),
    ),
    run: async (prepare, inputBytes) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "active-accounting" &&
            value.kind !== "bounded-tail" &&
            value.kind !== "recent-text" &&
            value.kind !== "reactions" &&
            value.kind !== "conversation-binding" &&
            value.kind !== "transcript-binding" &&
            value.kind !== "artifacts" &&
            value.kind !== "summary" &&
            value.kind !== "message-page" &&
            value.kind !== "around-id" &&
            value.kind !== "source-messages" &&
            value.kind !== "recent-page" &&
            value.kind !== "rpc" &&
            value.kind !== "rpc-message" &&
            value.kind !== "http" &&
            value.kind !== "delta" &&
            value.kind !== "inline-visibility" &&
            value.kind !== "recent" &&
            value.kind !== "message-by-id" &&
            value.kind !== "message-count" &&
            value.kind !== "message-lookup")
        ) {
          throw new Error("Session history worker returned metadata instead of history");
        }
        return value;
      }),
    readTranscript: async (input, signal) => {
      const events: TranscriptEvent[] = [];
      const eventJson: string[] | undefined = input.includeEventJson ? [] : undefined;
      const eventSeqs: number[] | undefined = input.includeEventJson ? [] : undefined;
      let parts: string[] = [];
      let text: { encoding: string; decoder: TextDecoder } | undefined;
      const receiveChunk = (value: unknown) => {
        if (
          !isRecord(value) ||
          value.kind !== "transcript-hydration-chunk" ||
          typeof value.encoding !== "string" ||
          !Array.isArray(value.frames)
        ) {
          throw new Error("Session history worker returned an invalid transcript chunk");
        }
        if (!text) {
          text = {
            encoding: value.encoding,
            decoder: new TextDecoder(value.encoding, { ignoreBOM: true }),
          };
        } else if (text.encoding !== value.encoding) {
          throw new Error("Session history worker changed transcript encoding during transfer");
        }
        for (const frame of value.frames) {
          if (
            !isRecord(frame) ||
            !types.isUint8Array(frame.data) ||
            typeof frame.endOfEvent !== "boolean"
          ) {
            throw new Error("Session history worker returned an invalid transcript frame");
          }
          parts.push(text.decoder.decode(frame.data, { stream: !frame.endOfEvent }));
          if (frame.endOfEvent) {
            const json = parts.join("");
            events.push(JSON.parse(json));
            eventJson?.push(json);
            if (eventSeqs) {
              if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq)) {
                throw new Error("Transcript snapshot omitted its row sequence");
              }
              eventSeqs.push(frame.seq);
            }
            parts = [];
          }
        }
      };
      return await runRequest(
        () => ({ kind: "transcript-hydration", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            (value.kind !== "full" && value.kind !== "bounded")
          ) {
            throw new Error(
              "Session history worker returned another result instead of a transcript",
            );
          }
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
      "transcript-maintenance",
      "transcript maintenance facts",
      (value) => value,
    ),
    readCurrentTurnEntry: reader("current-turn-entry", "a current-turn entry", (value) => value),
    readRecentActiveEvents: reader(
      "recent-active-events",
      "recent active events",
      (value) => value.events,
    ),
    readLatestActiveMessage: reader(
      "latest-active-message",
      "the latest active message",
      (value) => value.message,
    ),
    readVoiceSessions: reader("voice-sessions", "voice sessions", (value) => value),
    readUsageCache: reader(
      "usage-refresh-lock",
      "usage cache",
      (value) => value,
      (input) => ({ kind: "usage-cache", ...input }),
    ),
    readMembershipFacts: reader("session-membership-facts", "membership facts", (value) => value),
    readMembers: reader("session-members", "members", (value) => value),
    readSuggestions: reader("session-suggestions", "suggestions", (value) => value.suggestions),
    readExactEntries: async (input, signal) => {
      const captured = { ...input, env: captureSessionTranscriptStorageEnvironment(input.env) };
      return runRequest(
        () => ({ kind: "session-exact-entries", ...captured }),
        JSON.stringify(captured).length * 2,
        (value) => {
          assertResultKind(value, "session-exact-entries", "exact entries");
          return value;
        },
        signal,
      );
    },
    readRowFacts: async (input) => {
      if (input.sessionKeys.length > MAX_SESSION_ROW_FACTS_KEYS) {
        throw new Error(`Session row facts support at most ${MAX_SESSION_ROW_FACTS_KEYS} keys`);
      }
      const captured = {
        env: { ...input.env },
        sessionKeys: [...input.sessionKeys],
        continuation: input.continuation ? { ...input.continuation } : undefined,
      };
      return await runRequest(
        () => ({ kind: "session-row-facts", ...captured }),
        JSON.stringify(captured).length * 2,
        (value) => {
          assertResultKind(value, "session-row-facts", "row facts");
          return value;
        },
      );
    },
    readSessionMaintenance: reader(
      "session-maintenance-read",
      "session maintenance facts",
      (value) => value,
    ),
    readProgressCard: reader("session-progress-card", "a progress card", (value) => value.card),
    readPendingInputHistory: reader(
      "session-pending-input-history",
      "pending input history",
      (value) => value.snapshot,
    ),
    readPendingInputReceipts: reader(
      "session-pending-input-receipts",
      "pending input receipts",
      (value) => value.receipts,
    ),
    readHarnessCompletionSource: reader(
      "session-harness-completion-source",
      "a harness completion source",
      (value) => value.snapshot,
    ),
    readPendingInputSource: reader(
      "session-pending-input-source",
      "a submitted input source",
      (value) => value.snapshot,
    ),
    readConversationDelivery: reader(
      "conversation-delivery",
      "a conversation delivery receipt",
      (value) => value.record,
    ),
    readGoalOperationReceipt: reader(
      "goal-operation-receipt",
      "a Goal operation receipt",
      (value) => value.result,
    ),
    readEntryResult: reader("session-entry-read", "an entry", (value) => ({
      ...(value.readError
        ? err(decodeSessionTranscriptWorkerReadError(value.readError))
        : ok(value.entry)),
      source: value.source,
      facts: value.facts,
    })),
    readEntryCurrent: reader(
      "session-entry-current",
      "entry currency facts",
      (value) => value.entry,
    ),
    readDiagnosticText: reader("session-diagnostic-text", "diagnostic text", (value) => value.text),
    // The native reader validates the selected file. Replacement after that read is best effort.
    readEntries: async (scope, continuation, expectedIdentity, ifRevision) => {
      const captured = expectedIdentity && { ...expectedIdentity };
      return runRequest(
        () => ({
          kind: "session-entry-list",
          scope,
          continuation,
          expectedIdentity: captured,
          ifRevision,
        }),
        JSON.stringify({ scope, continuation, expectedIdentity: captured, ifRevision }).length * 2,
        (value) => {
          assertResultKind(value, "session-entry-list", "entries");
          return value;
        },
      );
    },
    readStoreProjection: reader(
      "session-store-projection",
      "store projection admission",
      (value) => value,
    ),
    readStoreSummary: reader("session-store-summary", "a store summary", (value) => value.summary),
    readIdentityEvidence: reader(
      "session-identity-evidence",
      "identity evidence",
      (value) => value.evidence,
    ),
    readProjectionStatus: async (input, signal) =>
      await runRequest(
        () => ({ kind: "projection-status", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (typeof value !== "boolean") {
            throw new Error("Session history worker returned history instead of projection status");
          }
          return value;
        },
        signal,
      ),
    readEntryPresence: async (scope) =>
      await runRequest(
        () => ({ kind: "session-row-presence", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (typeof value !== "boolean") {
            throw new Error("Session history worker returned history instead of metadata presence");
          }
          return value;
        },
      ),
  };
}
