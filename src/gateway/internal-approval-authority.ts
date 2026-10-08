const internalApprovalGuards = new WeakSet<() => void>();

/** First-party producers retain their live owner; opaque SDK callbacks are never promoted. */
export function retainInternalApprovalCommitGuard<T extends () => void>(guard: T): T {
  internalApprovalGuards.add(guard);
  return guard;
}

export function isInternalApprovalCommitGuard(guard: (() => void) | undefined): boolean {
  return guard !== undefined && internalApprovalGuards.has(guard);
}
