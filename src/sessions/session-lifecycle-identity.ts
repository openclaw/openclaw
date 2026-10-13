export function normalizeSessionIdentities(
  scope: string,
  identities: Iterable<string | undefined>,
): string[] {
  const normalizedScope = scope.trim();
  if (!normalizedScope) {
    throw new Error("session lifecycle scope is required");
  }
  return Array.from(
    new Set(
      Array.from(identities, (identity) => identity?.trim()).filter(
        (identity): identity is string => Boolean(identity),
      ),
    ),
  )
    .map((identity) => JSON.stringify([normalizedScope, identity]))
    .toSorted();
}

/** Group a snapshot of owner-held identity keys without sharing its mutable indexes. */
export function collectSessionIdentityTargets(
  identities: Iterable<string>,
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const identity of identities) {
    // The lifecycle owner indexes only keys produced by normalizeSessionIdentities.
    const [scope, sessionIdentity]: [string, string] = JSON.parse(identity);
    const scoped = targets.get(scope) ?? new Set<string>();
    scoped.add(sessionIdentity);
    targets.set(scope, scoped);
  }
  return targets;
}
