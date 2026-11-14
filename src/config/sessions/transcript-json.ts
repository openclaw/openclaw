// Keep only immutable payload roots across appends, not every retained descendant.
const ownedTranscriptRoots = new WeakSet<object>();

/** Normalization seals these payload roots before they can be shared across views. */
export function isOwnedTranscriptPayload(value: object): boolean {
  return ownedTranscriptRoots.has(value);
}

/** Retain a payload only after normalization has sealed it. */
export function retainOwnedTranscriptPayload(value: object): void {
  ownedTranscriptRoots.add(value);
}

/** Keep admitted children shared when replacing an immutable payload's envelope. */
export function cloneTranscriptEnvelope<T extends object>(value: T): T {
  if (ownedTranscriptRoots.has(value)) {
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        ownedTranscriptRoots.add(child);
      }
    }
  }
  return { ...value };
}
