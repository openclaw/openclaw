/**
 * Appends normalized, unique environment-variable candidates to a keyed bucket.
 *
 * `target` must be a prototype-less object: `ownerId` is plugin-controlled, and on an ordinary
 * object a `__proto__`/`constructor` owner would resolve an inherited member instead of a bucket
 * (assigning through `??=` there lands on `Object.prototype`, so the name is silently dropped, and
 * `new Set(bucket)` throws). A null prototype keeps those ids as ordinary own keys.
 */
export function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  ownerId: string,
  keys: readonly string[],
): void {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedOwnerId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
}
