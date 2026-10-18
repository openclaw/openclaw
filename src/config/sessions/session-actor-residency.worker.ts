import { serialize } from "node:v8";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";

const MAX_RESIDENT_SESSIONS = 128;
const MAX_RESIDENT_BYTES = 8 * 1024 * 1024;

/** Residency belongs to one serialized session actor worker. */
export function createSessionActorResidency() {
  const residents = new Map<
    string,
    { state: SessionActorStoredState; bytes: number | undefined }
  >();
  let residentBytes = 0;
  const drop = (key: string) => {
    residentBytes -= residents.get(key)?.bytes ?? 0;
    residents.delete(key);
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
      drop(key);
      // Receipts own appended bodies; residency keeps navigation and byte accounting.
      state.transcript.contextMetadata = state.hot.transcript.projection?.contextMetadata;
      state.transcript.payloads = new Map();
      // A sole resident is exempt from the byte cap; measure it when another key competes.
      const bytes = residents.size === 0 ? undefined : serialize(state).byteLength;
      if (residents.size === 1) {
        for (const resident of residents.values()) {
          if (resident.bytes === undefined) {
            resident.bytes = serialize(resident.state).byteLength;
            residentBytes += resident.bytes;
          }
        }
      }
      residents.set(key, { state, bytes });
      residentBytes += bytes ?? 0;
      // Keep one oversized working set until another key displaces it; dropping it
      // here would make every read-to-command version check fail after rehydration.
      for (const oldest of residents.keys()) {
        if (
          residents.size <= MAX_RESIDENT_SESSIONS &&
          (residents.size <= 1 || residentBytes <= MAX_RESIDENT_BYTES)
        ) {
          break;
        }
        drop(oldest);
      }
    },
    clear() {
      residents.clear();
      residentBytes = 0;
    },
  };
}
