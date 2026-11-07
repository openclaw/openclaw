import { internSessionSkillSnapshot } from "./session-skill-snapshot-intern.js";
import type { SessionEntry } from "./types.js";

// Residency is a heap estimate, not a wire-size limit. Trusted postimages are
// acyclic plain data; count strings without allocating or scanning their JSON.
export function estimateSessionActorReplicaBytes(
  value: unknown,
  sizes?: WeakMap<object, number>,
  memoizeDescendants = true,
): number {
  if (typeof value === "string") {
    return 16 + value.length * 2;
  }
  if (!value || typeof value !== "object") {
    return 8;
  }
  const known = sizes?.get(value);
  if (known !== undefined) {
    return known;
  }
  const childSizes = memoizeDescendants ? sizes : undefined;
  let bytes = 32;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (index in value) {
        bytes += 16 + estimateSessionActorReplicaBytes(value[index], childSizes, false);
      }
    }
  } else {
    for (const key in value) {
      bytes +=
        16 + key.length * 2 + estimateSessionActorReplicaBytes(Reflect.get(value, key), childSizes);
    }
  }
  sizes?.set(value, bytes);
  return bytes;
}

export function shareSessionActorReplicaEntrySkills(
  entry: SessionEntry | undefined,
): SessionEntry | undefined {
  if (!entry?.skillsSnapshot) {
    return entry;
  }
  const snapshot = entry.skillsSnapshot;
  const shared = internSessionSkillSnapshot(snapshot);
  if (shared !== snapshot) {
    // Prepared publications can be frozen; worker-decoded entries remain owned here.
    if (Object.isFrozen(entry)) {
      return { ...entry, skillsSnapshot: shared };
    }
    entry.skillsSnapshot = shared;
  }
  return entry;
}
