import { createHash } from "node:crypto";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const MAX_ENTRIES = 128;
const MAX_BYTES = 16 * 1024 * 1024;

export type PublicSessionRepresentation = {
  readonly body: string | Buffer;
  readonly etag: string;
  isCurrent(): boolean;
};

type Entry = {
  sessionKey: string;
  bytes: number;
  representation?: PublicSessionRepresentation;
};

/** The route owns this bounded derived cache; publication authority is never cached here. */
export function createPublicSessionRepresentationCache() {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  const remove = (key: string, entry: Entry) => {
    bytes -= entry.bytes;
    entries.delete(key);
  };
  const invalidate = (sessionKey?: string) => {
    for (const [key, entry] of entries) {
      if (!sessionKey || entry.sessionKey === sessionKey) {
        remove(key, entry);
      }
    }
  };
  const stop = [
    sessionChanges.subscribe((change) =>
      invalidate("sessionKey" in change ? change.sessionKey : undefined),
    ),
    onInternalSessionTranscriptUpdate((update) =>
      invalidate(update.target?.sessionKey ?? update.sessionKey),
    ),
  ];
  return {
    get(key: string): PublicSessionRepresentation | undefined {
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.representation) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry.representation;
    },
    begin(key: string, sessionKey: string) {
      const previous = entries.get(key);
      if (previous) {
        remove(key, previous);
      }
      while (entries.size >= MAX_ENTRIES) {
        const oldest = entries.entries().next().value;
        if (!oldest) {
          break;
        }
        remove(...oldest);
      }
      const entry: Entry = {
        sessionKey,
        bytes: 0,
      };
      entries.set(key, entry);
      const isCurrent = () => entries.get(key) === entry;
      return {
        isCurrent,
        complete(body: string | Buffer): PublicSessionRepresentation | undefined {
          if (!isCurrent()) {
            return undefined;
          }
          const representation: PublicSessionRepresentation = {
            body,
            etag: `"${createHash("sha256").update(body).digest("base64url")}"`,
            isCurrent,
          };
          const size = Buffer.byteLength(body);
          if (size > MAX_BYTES) {
            remove(key, entry);
            return representation;
          }
          // Completion, not build admission, makes this representation most recently used.
          entries.delete(key);
          entries.set(key, entry);
          for (const [oldestKey, oldest] of entries) {
            if (bytes + size <= MAX_BYTES) {
              break;
            }
            remove(oldestKey, oldest);
          }
          entry.bytes = size;
          entry.representation = representation;
          bytes += size;
          return representation;
        },
        cancel() {
          if (entries.get(key) === entry) {
            remove(key, entry);
          }
        },
      };
    },
    dispose() {
      for (const unsubscribe of stop) {
        unsubscribe();
      }
      invalidate();
    },
  };
}
