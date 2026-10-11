import { createHash } from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const MAX_ENTRIES = 128;
const MAX_BYTES = 16 * 1024 * 1024;

export type PublicSessionRepresentation = {
  readonly body: string;
  readonly etag: string;
  isCurrent(): boolean;
};

type Entry = {
  sessionKey: string;
  config: OpenClawConfig;
  current: boolean;
  bytes: number;
  representation?: PublicSessionRepresentation;
};

/** The route owns this bounded derived cache; publication authority is never cached here. */
export function createPublicSessionRepresentationCache() {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  let active = true;
  const remove = (key: string, entry: Entry) => {
    entry.current = false;
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
    get(key: string, config: OpenClawConfig): PublicSessionRepresentation | undefined {
      const entry = entries.get(key);
      if (!active || !entry) {
        return undefined;
      }
      if (entry.config !== config) {
        remove(key, entry);
        return undefined;
      }
      if (entry.representation) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry.representation;
    },
    begin(key: string, sessionKey: string, config: OpenClawConfig) {
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
        config,
        current: active,
        bytes: 0,
      };
      const isCurrent = () => active && entry.current;
      if (active) {
        entries.set(key, entry);
      }
      return {
        isCurrent,
        complete(body: string): PublicSessionRepresentation | undefined {
          if (!isCurrent()) {
            return undefined;
          }
          if (entry.representation) {
            return entry.representation;
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
          for (const [oldestKey, oldest] of entries) {
            if (bytes + size <= MAX_BYTES) {
              break;
            }
            remove(oldestKey, oldest);
          }
          if (entry.current) {
            entry.bytes = size;
            entry.representation = representation;
            bytes += size;
          }
          return representation;
        },
        cancel() {
          if (entry.current) {
            remove(key, entry);
          }
        },
      };
    },
    dispose() {
      active = false;
      for (const unsubscribe of stop) {
        unsubscribe();
      }
      invalidate();
    },
  };
}
