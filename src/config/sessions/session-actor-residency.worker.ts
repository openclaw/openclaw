import { serialize } from "node:v8";
import { projectSessionActorContextMetadata } from "./session-actor-context-metadata.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { retainSessionActorTranscriptWindow } from "./session-actor-transcript-window.worker.js";

const MAX_RESIDENT_SESSIONS = 128;
const MAX_RESIDENT_BYTES = 8 * 1024 * 1024;

/** Residency belongs to one serialized session actor worker. */
export function createSessionActorResidency() {
  const residents = new Map<
    string,
    { state: SessionActorStoredState; bytes: number | undefined }
  >();
  let residentBytes = 0;
  let oversizedKey: string | undefined;
  const drop = (key: string) => {
    residentBytes -= residents.get(key)?.bytes ?? 0;
    residents.delete(key);
    if (oversizedKey === key) {
      oversizedKey = undefined;
    }
  };
  const measure = (key: string, state: SessionActorStoredState) => {
    const bytes = serialize(state).byteLength;
    if (bytes <= MAX_RESIDENT_BYTES) {
      return bytes;
    }
    // One oversized working set can coexist with the ordinary byte budget.
    if (oversizedKey !== undefined) {
      drop(oversizedKey);
    }
    oversizedKey = key;
    return 0;
  };
  return {
    get: (key: string) => residents.get(key)?.state,
    touch(key: string) {
      const held = residents.get(key)!;
      residents.delete(key);
      residents.set(key, held);
    },
    drop,
    remember(state: SessionActorStoredState) {
      const key = state.hot.target.sessionKey;
      const oversized = oversizedKey === key;
      drop(key);
      retainSessionActorTranscriptWindow(state);
      // Receipts own appended bodies; residency keeps navigation and byte accounting.
      state.transcript.contextMetadata = projectSessionActorContextMetadata(state);
      state.transcript.payloads = new Map();
      // A sole resident is exempt from the byte cap; measure it when another key competes.
      if (residents.size === 1) {
        for (const [residentKey, resident] of residents) {
          if (resident.bytes === undefined) {
            resident.bytes = measure(residentKey, resident.state);
            residentBytes += resident.bytes;
          }
        }
      }
      // Keep the allowance until eviction/invalidation, even if an own write shrinks it.
      // Measuring an already exempt working set only allocates another full serialization.
      const bytes = oversized ? 0 : residents.size === 0 ? undefined : measure(key, state);
      if (oversized) {
        oversizedKey = key;
      }
      residents.set(key, { state, bytes });
      residentBytes += bytes ?? 0;
      // Both ordinary and oversized actors age out through the same count-bound LRU.
      for (const oldest of residents.keys()) {
        if (
          residents.size <= MAX_RESIDENT_SESSIONS &&
          (residents.size <= 1 || residentBytes <= MAX_RESIDENT_BYTES)
        ) {
          break;
        }
        if (oldest !== oversizedKey || residents.size > MAX_RESIDENT_SESSIONS) {
          drop(oldest);
        }
      }
    },
    clear() {
      residents.clear();
      residentBytes = 0;
      oversizedKey = undefined;
    },
  };
}
