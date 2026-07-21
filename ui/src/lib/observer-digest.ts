// Freshest-wins reconciliation for observer digest copies (live event map vs
// projected session row). Revisions are session-monotonic by server contract
// (revision floors preserve continuity across runs), so cross-copy comparison
// by revision, then updatedAt, is safe.
type ComparableObserverDigest = { revision: number; updatedAt: number };

export function pickFreshestObserverDigest<T extends ComparableObserverDigest>(
  first: T | null | undefined,
  second: T | null | undefined,
): T | null {
  if (!first) {
    return second ?? null;
  }
  if (!second) {
    return first;
  }
  if (first.revision !== second.revision) {
    return first.revision > second.revision ? first : second;
  }
  return first.updatedAt >= second.updatedAt ? first : second;
}
