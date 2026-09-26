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
  return {
    findTranscriptEvent: async (request) =>
      await runRequest(
        () => ({ kind: "transcript-match", request }),
        JSON.stringify(request).length * 2,
        (value) => {
          assertResultKind(value, "transcript-match", "a transcript match");
          return value.result;
        },
      ),
    readHistoricalEvictionCandidates: async (input) =>
      await runRequest(
        () => ({ kind: "historical-eviction-candidates", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "historical-eviction-candidates", "eviction candidates");
          return value.sessionIds;
        },
      ),
    readArchivePruning: async (input) =>
      await runRequest(
        () => ({ kind: "session-archive-pruning", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-archive-pruning", "archive pruning");
          return value.result;
        },
      ),
    readColdMetadata: async (input) =>
      await runRequest(
        () => ({ kind: "cold-metadata", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "cold-metadata", "cold metadata");
          return value;
        },
      ),
    searchTranscripts: async (params) =>
      await runRequest(
        () => ({ kind: "transcript-search", params }),
        JSON.stringify(params).length * 2,
        (value) => {
          assertResultKind(value, "transcript-search", "search");
          return value.result;
        },
      ),
    readPreview: async (input) =>
      await runRequest(
        () => ({ kind: "session-preview", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-preview", "a preview");
          return value.items;
        },
      ),
    readTitleFields: async (input) =>
      await runRequest(
        () => ({ kind: "session-title-fields", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-title-fields", "title fields");
          return value.fields;
        },
      ),
    readRowBackfill: async (params) =>
      await runRequest(
        () => ({ kind: "session-row-backfill", params }),
        JSON.stringify(params).length * 2,
        (value) => {
          assertResultKind(value, "session-row-backfill", "transcript fields");
          return value.fields;
        },
      ),
    run: async (prepare, inputBytes) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "transcript-binding" &&
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
        (value) => {
          assertResultKind(value, "current-turn-entry", "a current-turn entry");
          return value;
        },
        signal,
      ),
    readUsageCache: async (input) =>
      await runRequest(
        () => ({ kind: "usage-cache", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "usage-refresh-lock", "usage cache");
          return value;
        },
      ),
    readMembershipFacts: async (input) =>
      await runRequest(
        () => ({ kind: "session-membership-facts", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-membership-facts", "membership facts");
          return value;
        },
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
        (value) => {
          assertResultKind(value, "session-exact-entries", "exact entries");
          return value;
        },
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
        (value) => {
          assertResultKind(value, "session-row-facts", "row facts");
          return value;
        },
      );
    },
    readProgressCard: async (input) =>
      await runRequest(
        () => ({ kind: "session-progress-card", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-progress-card", "a progress card");
          return value.card;
        },
      ),
    readEntryResult: async (input) =>
      await runRequest(
        () => ({ kind: "session-entry-read", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-entry-read", "an entry");
          return value.readError
            ? err(decodeSessionTranscriptWorkerReadError(value.readError))
            : ok(value.entry);
        },
      ),
    readEntries: async (scope) =>
      await runRequest(
        () => ({ kind: "session-entry-list", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          assertResultKind(value, "session-entry-list", "entries");
          return value.entries;
        },
      ),
    readIdentityEvidence: async (input) =>
      await runRequest(
        () => ({ kind: "session-identity-evidence", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          assertResultKind(value, "session-identity-evidence", "identity evidence");
          return value.evidence;
        },
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
