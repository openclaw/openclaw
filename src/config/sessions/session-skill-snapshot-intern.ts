import { createHash } from "node:crypto";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import type { SessionSkillSnapshot } from "./session-prompt-types.js";

const snapshots = new Map<string, WeakRef<SessionSkillSnapshot>>();
const admitted = new WeakSet<SessionSkillSnapshot>();
const MAX_SNAPSHOTS = 256;

/** Replica inputs are decoded persisted JSON, never the mutable runtime skill catalog. */
export function internSessionSkillSnapshot(snapshot: SessionSkillSnapshot): SessionSkillSnapshot {
  if (admitted.has(snapshot)) {
    return snapshot;
  }
  // Preserve member order: equal prompts or revisions alone do not imply equal output bytes.
  const hash = createHash("sha256");
  if (typeof snapshot.prompt === "string") {
    // Hash the large prompt directly instead of allocating its JSON-escaped copy.
    // Its member position preserves output order; JSON cannot contain literal NUL.
    const { prompt, ...metadata } = snapshot;
    hash
      .update(JSON.stringify(metadata))
      .update(`\0${Object.keys(snapshot).indexOf("prompt")}\0`)
      .update(prompt, "utf16le");
  } else {
    // Persisted prompt references can omit the prompt body.
    hash.update(JSON.stringify(snapshot));
  }
  const key = hash.digest("hex");
  const existing = snapshots.get(key)?.deref();
  if (existing) {
    return existing;
  }
  freezeTrustedJsonSnapshot(snapshot);
  admitted.add(snapshot);
  snapshots.delete(key);
  snapshots.set(key, new WeakRef(snapshot));
  if (snapshots.size > MAX_SNAPSHOTS) {
    snapshots.delete(snapshots.keys().next().value!);
  }
  return snapshot;
}
