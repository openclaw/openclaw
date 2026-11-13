// Keep only immutable payload roots across appends, not every retained descendant.
const ownedTranscriptRoots = new WeakSet<object>();

/** Normalization seals these payload roots before they can be shared across views. */
export function isOwnedTranscriptPayload(value: object): boolean {
  return ownedTranscriptRoots.has(value);
}

/** Record a payload already sealed by transcript normalization. */
export function markOwnedTranscriptPayload(value: object): void {
  ownedTranscriptRoots.add(value);
}

/** Keep admitted children shared when replacing an immutable payload's envelope. */
export function cloneTranscriptEnvelope<T extends object>(value: T): T {
  if (isOwnedTranscriptPayload(value)) {
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        markOwnedTranscriptPayload(child);
      }
    }
  }
  return { ...value };
}
