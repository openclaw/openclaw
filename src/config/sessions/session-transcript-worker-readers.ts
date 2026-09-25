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

export type SessionHistoryWorkerRequestRunner = <TResult>(
  prepare: () => SessionHistoryWorkerPreparedInput,
  inputBytes: number,
  receive: (value: SessionTranscriptWorkerValues[SessionHistoryWorkerInput["kind"]]) => TResult,
  signal?: AbortSignal,
  onRequest?: (value: unknown) => void,
) => Promise<TResult>;

type HistoryWorkerValue = SessionTranscriptWorkerValues[SessionHistoryWorkerInput["kind"]];
type TaggedHistoryWorkerValue = Extract<HistoryWorkerValue, { kind: string }>;

function hasResultKind<Kind extends TaggedHistoryWorkerValue["kind"]>(
  value: HistoryWorkerValue,
  kind: Kind,
): value is Extract<TaggedHistoryWorkerValue, { kind: Kind }> {
  return typeof value !== "boolean" && !Array.isArray(value) && value.kind === kind;
}

function readResult<Kind extends TaggedHistoryWorkerValue["kind"]>(
  value: HistoryWorkerValue,
  kind: Kind,
  label: string,
) {
  if (!hasResultKind(value, kind)) {
    throw new Error(`Session history worker returned another result instead of ${label}`);
  }
  return value;
}

/** Decode domain results; database custody remains with the enclosing history owner. */
export function createSessionHistoryWorkerReaders(
  runRequest: SessionHistoryWorkerRequestRunner,
): Omit<SessionHistoryWorkerDatabase, "generation" | "assertCurrent"> {
  return {
    readPendingArchives: async (input, signal) =>
      await runRequest(
        () => ({ kind: "session-pending-archives", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-pending-archives", "pending archives");
          return value.pending;
        },
        signal,
      ),
    findTranscriptEvent: async (request) =>
      await runRequest(
        () => ({ kind: "transcript-match", request }),
        JSON.stringify(request).length * 2,
        (value) => readResult(value, "transcript-match", "a transcript match").result,
      ),
    readHistoricalEvictionCandidates: async (input) =>
      await runRequest(
        () => ({ kind: "historical-eviction-candidates", ...input }),
        JSON.stringify(input).length * 2,
        (value) =>
          readResult(value, "historical-eviction-candidates", "eviction candidates").sessionIds,
      ),
    readArchivePruning: async (input) =>
      await runRequest(
        () => ({ kind: "session-archive-pruning", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-archive-pruning", "archive pruning").result,
      ),
    readColdMetadata: async (input) =>
      await runRequest(
        () => ({ kind: "cold-metadata", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "cold-metadata", "cold metadata"),
      ),
    searchTranscripts: async (params) =>
      await runRequest(
        () => ({ kind: "transcript-search", params }),
        JSON.stringify(params).length * 2,
        (value) => readResult(value, "transcript-search", "search").result,
      ),
    readPreview: async (input) =>
      await runRequest(
        () => ({ kind: "session-preview", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-preview", "a preview").items,
      ),
    readTitleFields: async (input) =>
      await runRequest(
        () => ({ kind: "session-title-fields", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-title-fields", "title fields").fields,
      ),
    readRowBackfill: async (params) =>
      await runRequest(
        () => ({ kind: "session-row-backfill", params }),
        JSON.stringify(params).length * 2,
        (value) => readResult(value, "session-row-backfill", "transcript fields").fields,
      ),
    run: async (prepare, inputBytes) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "transcript-binding" &&
            value.kind !== "artifacts" &&
            value.kind !== "message-page" &&
            value.kind !== "around-id" &&
            value.kind !== "source-messages" &&
            value.kind !== "recent-page" &&
            value.kind !== "rpc" &&
            value.kind !== "http" &&
            value.kind !== "delta" &&
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
    readCurrentTurnEntry: async (input, signal) =>
      await runRequest(
        () => ({ kind: "current-turn-entry", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "current-turn-entry", "a current-turn entry"),
        signal,
      ),
    readUsageCache: async (input) =>
      await runRequest(
        () => ({ kind: "usage-cache", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "usage-refresh-lock", "usage cache"),
      ),
    readMembershipFacts: async (input) =>
      await runRequest(
        () => ({ kind: "session-membership-facts", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-membership-facts", "membership facts"),
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
    readExactEntries: async (input, signal) =>
      await runRequest(
        () => ({ kind: "session-exact-entries", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-exact-entries", "exact entries"),
        signal,
      ),
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
        (value) => readResult(value, "session-row-facts", "row facts"),
      );
    },
    readProgressCard: async (input) =>
      await runRequest(
        () => ({ kind: "session-progress-card", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-progress-card", "a progress card").card,
      ),
    readEntryResult: async (input) =>
      await runRequest(
        () => ({ kind: "session-entry-read", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          const result = readResult(value, "session-entry-read", "an entry");
          return result.readError
            ? err(decodeSessionTranscriptWorkerReadError(result.readError))
            : ok(result.entry);
        },
      ),
    readDiagnosticText: async (input) =>
      await runRequest(
        () => ({ kind: "session-diagnostic-text", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-diagnostic-text", "diagnostic text");
          return value.text;
        },
      ),
    readEntries: async (scope) =>
      await runRequest(
        () => ({ kind: "session-entry-list", scope }),
        JSON.stringify(scope).length * 2,
        (value) => readResult(value, "session-entry-list", "entries").entries,
      ),
    readIdentityEvidence: async (input) =>
      await runRequest(
        () => ({ kind: "session-identity-evidence", ...input }),
        JSON.stringify(input).length * 2,
        (value) => readResult(value, "session-identity-evidence", "identity evidence").evidence,
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
