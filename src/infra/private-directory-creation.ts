const refusedCreations = new WeakSet<object>();

/** Record a completed native refusal without replacing its code, errno, or identity. */
export function markPrivateDirectoryCreationRefused<T>(error: T): T {
  if (error !== null && typeof error === "object") {
    refusedCreations.add(error);
  }
  return error;
}

export function isPrivateDirectoryCreationRefused(error: unknown): boolean {
  return error !== null && typeof error === "object" && refusedCreations.has(error);
}
