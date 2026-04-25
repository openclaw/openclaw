import { delayedContinuationReservationCount } from "../continuation-delegate-store.js";

type ContinuationTimerHandle = ReturnType<typeof setTimeout>;

const continuationGenerations = new Map<string, number>();
const continuationTimerRefs = new Map<string, number>();
const continuationTimerHandles = new Map<string, Set<ContinuationTimerHandle>>();
const delegatePendingFlags = new Map<string, boolean>();

export function setDelegatePending(sessionKey: string): void {
  delegatePendingFlags.set(sessionKey, true);
}

export function hasDelegatePending(sessionKey: string): boolean {
  return delegatePendingFlags.get(sessionKey) === true;
}

export function clearDelegatePending(sessionKey: string): void {
  delegatePendingFlags.delete(sessionKey);
  bumpContinuationGeneration(sessionKey);
  maybeDropContinuationGeneration(sessionKey);
}

export function clearDelegatePendingIfNoDelayedReservations(sessionKey: string): void {
  if (delayedContinuationReservationCount(sessionKey) === 0) {
    clearDelegatePending(sessionKey);
  }
}

export function currentContinuationGeneration(sessionKey: string): number {
  return continuationGenerations.get(sessionKey) ?? 0;
}

export function bumpContinuationGeneration(sessionKey: string): number {
  const next = currentContinuationGeneration(sessionKey) + 1;
  continuationGenerations.set(sessionKey, next);
  return next;
}

export function hasLiveContinuationTimerRefs(sessionKey: string): boolean {
  return (continuationTimerRefs.get(sessionKey) ?? 0) > 0;
}

export function maybeDropContinuationGeneration(sessionKey: string): void {
  if (hasLiveContinuationTimerRefs(sessionKey)) {
    return;
  }
  if (delayedContinuationReservationCount(sessionKey) > 0) {
    return;
  }
  continuationGenerations.delete(sessionKey);
}

export function retainContinuationTimerRef(sessionKey: string): void {
  continuationTimerRefs.set(sessionKey, (continuationTimerRefs.get(sessionKey) ?? 0) + 1);
}

export function releaseContinuationTimerRef(sessionKey: string): void {
  const current = continuationTimerRefs.get(sessionKey) ?? 0;
  if (current <= 1) {
    continuationTimerRefs.delete(sessionKey);
  } else {
    continuationTimerRefs.set(sessionKey, current - 1);
  }
  maybeDropContinuationGeneration(sessionKey);
}

export function registerContinuationTimerHandle(
  sessionKey: string,
  handle: ContinuationTimerHandle,
): void {
  const existing = continuationTimerHandles.get(sessionKey);
  if (existing) {
    existing.add(handle);
    return;
  }
  continuationTimerHandles.set(sessionKey, new Set([handle]));
}

export function unregisterContinuationTimerHandle(
  sessionKey: string,
  handle: ContinuationTimerHandle,
): boolean {
  const existing = continuationTimerHandles.get(sessionKey);
  if (!existing?.delete(handle)) {
    return false;
  }
  if (existing.size === 0) {
    continuationTimerHandles.delete(sessionKey);
  }
  releaseContinuationTimerRef(sessionKey);
  return true;
}

export function clearTrackedContinuationTimers(sessionKey: string): void {
  const existing = continuationTimerHandles.get(sessionKey);
  if (!existing || existing.size === 0) {
    return;
  }
  continuationTimerHandles.delete(sessionKey);
  for (const handle of existing) {
    clearTimeout(handle);
    const releaseHandle = setTimeout(() => {
      releaseContinuationTimerRef(sessionKey);
    }, 0);
    releaseHandle.unref();
  }
}
