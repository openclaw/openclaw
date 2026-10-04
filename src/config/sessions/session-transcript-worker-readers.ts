import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
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
  onRequest?: (value: unknown) => void,
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
  function reader<K extends Extract<SessionHistoryWorkerValue, { kind: string }>["kind"], Input, T>(
    kind: K,
    expected: string,
    prepare: (input: Input) => SessionHistoryWorkerPreparedInput,
    project: (value: Extract<SessionHistoryWorkerValue, { kind: K }>) => T,
  ): (input: Input, signal?: AbortSignal) => Promise<T> {
    return async (input, signal) =>
      runRequest(
        () => prepare(input),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, kind, expected);
          return project(value);
        },
        signal,
      );
  }
  return {
    readRuntimeTarget: reader(
      "session-runtime-target",
      "runtime transcript target",
      (input) => ({ kind: "session-runtime-target", ...input }),
      (value) => value.target,
    ),
    readConversations: reader(
      "conversation-rows",
      "conversations",
      (input) => ({ kind: "conversation-rows", ...input }),
      (value) => value.rows,
    ),
    prewarm: reader(
      "prewarm",
      "prewarm acknowledgement",
      (input) => ({ kind: "prewarm", ...input }),
      () => undefined,
    ),
    readPendingArchives: reader(
      "session-pending-archives",
      "pending archives",
      (input) => ({ kind: "session-pending-archives", ...input }),
      (value) => value.pending,
    ),
    readLifecycleArtifactPlan: reader(
      "lifecycle-artifact-plan",
      "lifecycle artifact plan",
      (input) => ({ kind: "lifecycle-artifact-plan", ...input }),
      (value) => value,
    ),
    readMemorySessionTargets: reader(
      "memory-session-targets",
      "memory session targets",
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
      "session-archive-inventory",
      "archive inventory",
      (input) => ({
        kind: "session-archive-inventory",
        ...input,
        env: captureSessionTranscriptStorageEnvironment(input.env ?? process.env),
      }),
      (value) => value.archives,
    ),
    readCorpusInventory: reader(
      "session-corpus-inventory",
      "corpus inventory",
      (input) => ({
        kind: "session-corpus-inventory",
        ...input,
        scope: { ...input.scope, env: captureSessionTranscriptStorageEnvironment(input.scope.env) },
      }),
      (value) => value.entries,
    ),
    readArchivePresence: reader(
      "session-archive-presence",
      "archive presence",
      (input) => ({ kind: "session-archive-presence", ...input }),
      (value) => value.registered,
    ),
    findTranscriptEvent: reader(
      "transcript-match",
      "a transcript match",
      (request) => ({ kind: "transcript-match", request }),
      (value) => value.result,
    ),
    readHistoricalEvictionCandidates: reader(
      "historical-eviction-candidates",
      "eviction candidates",
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
      "historical-eviction-candidates",
      "archived eviction candidates",
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
      "session-archive-pruning",
      "archive pruning",
      (input) => ({ kind: "session-archive-pruning", ...input }),
      (value) => value.result,
    ),
    readColdMetadata: reader(
      "cold-metadata",
      "cold metadata",
      (input) => ({ kind: "cold-metadata", ...input }),
      (value) => value,
    ),
    readColdStorageInventory: reader(
      "cold-storage-inventory",
      "cold storage inventory",
      (input) => ({ kind: "cold-storage-inventory", ...input }),
      (value) => value,
    ),
    searchTranscripts: reader(
      "transcript-search",
      "search",
      (params) => ({ kind: "transcript-search", params }),
      (value) => value.result,
    ),
    readPreview: reader(
      "session-preview",
      "a preview",
      (input) => ({ kind: "session-preview", ...input }),
      (value) => value.items,
    ),
    readTitleFields: reader(
      "session-title-fields",
      "title fields",
      (input) => ({ kind: "session-title-fields", ...input }),
      (value) => value.fields,
    ),
    readWatermark: reader(
      "transcript-watermark",
      "a transcript watermark",
      (input) => ({ kind: "transcript-watermark", ...input }),
      (value) => value.watermark,
    ),
    readActivitySummarySource: reader(
      "session-activity-summary-source",
      "an Activity recap source",
      (input) => ({ kind: "session-activity-summary-source", ...input }),
      (value) => value.source,
    ),
    readRowBackfill: reader(
      "session-row-backfill",
      "transcript fields",
      (params) => ({ kind: "session-row-backfill", params }),
      (value) => value.fields,
    ),
    run: async (prepare, inputBytes) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "active-accounting" &&
            value.kind !== "bounded-tail" &&
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
            !(frame.data instanceof Uint8Array) ||
            typeof frame.endOfEvent !== "boolean"
          ) {
            throw new Error("Session history worker returned an invalid transcript frame");
          }
          parts.push(text.decoder.decode(frame.data, { stream: !frame.endOfEvent }));
          if (frame.endOfEvent) {
            events.push(JSON.parse(parts.join("")));
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
          return { kind: "full", snapshot: { events, version: value.version } };
        },
        signal,
        input.limits ? undefined : receiveChunk,
      );
    },
    readMaintenance: reader(
      "transcript-maintenance",
      "transcript maintenance facts",
      (input) => ({ kind: "transcript-maintenance", ...input }),
      (value) => value,
    ),
    readCurrentTurnEntry: reader(
      "current-turn-entry",
      "a current-turn entry",
      (input) => ({ kind: "current-turn-entry", ...input }),
      (value) => value,
    ),
    readRecentActiveEvents: reader(
      "recent-active-events",
      "recent active events",
      (input) => ({ kind: "recent-active-events", ...input }),
      (value) => value.events,
    ),
    readLatestActiveMessage: reader(
      "latest-active-message",
      "the latest active message",
      (input) => ({ kind: "latest-active-message", ...input }),
      (value) => value.message,
    ),
    readUsageCache: reader(
      "usage-refresh-lock",
      "usage cache",
      (input) => ({ kind: "usage-cache", ...input }),
      (value) => value,
    ),
    readMembershipFacts: reader(
      "session-membership-facts",
      "membership facts",
      (input) => ({ kind: "session-membership-facts", ...input }),
      (value) => value,
    ),
    readMembers: async (input) =>
      await runRequest(
        () => ({ kind: "session-members", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (!Array.isArray(value)) {
            throw new Error("Session history worker returned another result instead of members");
          }
          return value;
        },
      ),
    readSuggestions: reader(
      "session-suggestions",
      "suggestions",
      (input) => ({ kind: "session-suggestions", ...input }),
      (value) => value.suggestions,
    ),
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
    readProgressCard: reader(
      "session-progress-card",
      "a progress card",
      (input) => ({ kind: "session-progress-card", ...input }),
      (value) => value.card,
    ),
    readPendingInputHistory: reader(
      "session-pending-input-history",
      "pending input history",
      (input) => ({ kind: "session-pending-input-history", ...input }),
      (value) => value.snapshot,
    ),
    readPendingInputReceipts: reader(
      "session-pending-input-receipts",
      "pending input receipts",
      (input) => ({ kind: "session-pending-input-receipts", ...input }),
      (value) => value.receipts,
    ),
    readPendingInputSource: reader(
      "session-pending-input-source",
      "a submitted input source",
      (input) => ({ kind: "session-pending-input-source", ...input }),
      (value) => value.snapshot,
    ),
    readConversationDelivery: reader(
      "conversation-delivery",
      "a conversation delivery receipt",
      (input) => ({ kind: "conversation-delivery", ...input }),
      (value) => value.record,
    ),
    readGoalOperationReceipt: reader(
      "goal-operation-receipt",
      "a Goal operation receipt",
      (input) => ({ kind: "goal-operation-receipt", ...input }),
      (value) => value.result,
    ),
    readEntryResult: reader(
      "session-entry-read",
      "an entry",
      (input) => ({ kind: "session-entry-read", ...input }),
      (value) =>
        value.readError
          ? err(decodeSessionTranscriptWorkerReadError(value.readError))
          : ok(value.entry),
    ),
    readEntryCurrent: reader(
      "session-entry-current",
      "entry currency facts",
      (input) => ({ kind: "session-entry-current", ...input }),
      (value) => value.entry,
    ),
    readDiagnosticText: reader(
      "session-diagnostic-text",
      "diagnostic text",
      (input) => ({ kind: "session-diagnostic-text", ...input }),
      (value) => value.text,
    ),
    readEntries: async (scope, continuation) =>
      runRequest(
        () => ({ kind: "session-entry-list", scope, continuation }),
        JSON.stringify({ scope, continuation }).length * 2,
        (value) => {
          assertResultKind(value, "session-entry-list", "entries");
          return value.entries;
        },
      ),
    readStoreSummary: reader(
      "session-store-summary",
      "a store summary",
      (input) => ({ kind: "session-store-summary", ...input }),
      (value) => value.summary,
    ),
    readIdentityEvidence: reader(
      "session-identity-evidence",
      "identity evidence",
      (input) => ({ kind: "session-identity-evidence", ...input }),
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
