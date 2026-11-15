import { createHash } from "node:crypto";
import { freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";

const snapshots = new Map<string, WeakRef<object>>();
const admitted = new WeakMap<object, string>();
const MAX_SNAPSHOTS = 256;

/** Replica inputs are decoded persisted JSON, never the mutable runtime skill catalog. */
export function sessionEntryFieldKey(snapshot: object): string {
  const known = admitted.get(snapshot);
  if (known) {
    return known;
  }
  // Preserve member order: equal prompts or revisions alone do not imply equal output bytes.
  const hash = createHash("sha256");
  if ("prompt" in snapshot && typeof snapshot.prompt === "string") {
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
  freezeTrustedJsonSnapshot(snapshot);
  admitted.set(snapshot, key);
  return key;
}

export function internSessionEntryField<T extends object>(snapshot: T): T {
  const key = sessionEntryFieldKey(snapshot);
  const existing = snapshots.get(key)?.deref();
  if (existing) {
    // The content digest includes the complete JSON shape and member order.
    return existing as T;
  }
  snapshots.delete(key);
  snapshots.set(key, new WeakRef(snapshot));
  if (snapshots.size > MAX_SNAPSHOTS) {
    snapshots.delete(snapshots.keys().next().value!);
  }
  return snapshot;
}
