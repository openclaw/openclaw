import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
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

/** Decode domain results; database custody remains with the enclosing history owner. */
export function createSessionHistoryWorkerReaders(
  runRequest: SessionHistoryWorkerRequestRunner,
): Omit<SessionHistoryWorkerDatabase, "generation" | "assertCurrent"> {
  return {
    searchTranscripts: async (params) =>
      await runRequest(
        () => ({ kind: "transcript-search", params }),
        JSON.stringify(params).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "transcript-search"
          ) {
            throw new Error("Session history worker returned another result instead of search");
          }
          return value.result;
        },
      ),
    readPreview: async (input) =>
      await runRequest(
        () => ({ kind: "session-preview", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-preview"
          ) {
            throw new Error("Session history worker returned another result instead of a preview");
          }
          return value.items;
        },
      ),
    readTitleFields: async (input) =>
      await runRequest(
        () => ({ kind: "session-title-fields", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-title-fields"
          ) {
            throw new Error(
              "Session history worker returned another result instead of title fields",
            );
          }
          return value.fields;
        },
      ),
    run: async (prepare, inputBytes) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "rpc" &&
            value.kind !== "http" &&
            value.kind !== "delta" &&
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
    readUsageCache: async (input) =>
      await runRequest(
        () => ({ kind: "usage-cache", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "usage-refresh-lock"
          ) {
            throw new Error(
              "Session history worker returned another result instead of usage cache",
            );
          }
          return value;
        },
      ),
    readMembershipFacts: async (input) =>
      await runRequest(
        () => ({ kind: "session-membership-facts", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-membership-facts"
          ) {
            throw new Error(
              "Session history worker returned another result instead of membership facts",
            );
          }
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
    readExactEntries: async (input) =>
      await runRequest(
        () => ({ kind: "session-exact-entries", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-exact-entries"
          ) {
            throw new Error(
              "Session history worker returned another result instead of exact entries",
            );
          }
          return value;
        },
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
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-row-facts"
          ) {
            throw new Error("Session history worker returned another result instead of row facts");
          }
          return value;
        },
      );
    },
    readProgressCard: async (input) =>
      await runRequest(
        () => ({ kind: "session-progress-card", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-progress-card"
          ) {
            throw new Error(
              "Session history worker returned another result instead of a progress card",
            );
          }
          return value.card;
        },
      ),
    readEntries: async (scope) =>
      await runRequest(
        () => ({ kind: "session-entry-list", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-entry-list"
          ) {
            throw new Error("Session history worker returned another result instead of entries");
          }
          return value.entries;
        },
      ),
    readIdentityEvidence: async (input) =>
      await runRequest(
        () => ({ kind: "session-identity-evidence", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-identity-evidence"
          ) {
            throw new Error(
              "Session history worker returned another result instead of identity evidence",
            );
          }
          return value.evidence;
        },
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
