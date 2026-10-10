import { parseAgentSessionKey } from "../routing/session-key.js";

type CanonicalOwnerEvidenceItem = {
  canonicalKey: string;
  canonicalOwnerSessionKey?: string;
  sessionKey: string;
  storedKey: string;
  target: { agentId: string; sqlitePath: string };
};

/** Projects transcript-owner evidence through aliases and indexes every proven source key. */
export function applyCanonicalOwnerEvidence(
  inventory: CanonicalOwnerEvidenceItem[],
): Map<string, Set<string>> {
  const bySessionKey = new Map(
    inventory.map((item) => [`${item.target.sqlitePath}\0${item.sessionKey}`, item] as const),
  );
  const resolved = new Map<CanonicalOwnerEvidenceItem, string>();
  const resolveCanonicalKey = (item: CanonicalOwnerEvidenceItem): string => {
    const seen = new Set<CanonicalOwnerEvidenceItem>();
    let current = item;
    let canonicalKey: string;
    for (;;) {
      const cached = resolved.get(current);
      if (cached !== undefined) {
        canonicalKey = cached;
        break;
      }
      if (seen.has(current)) {
        // Cycles keep the repeated row's key; caching that choice would change later roots.
        return current.canonicalKey;
      }
      seen.add(current);
      const owner = current.canonicalOwnerSessionKey
        ? bySessionKey.get(`${current.target.sqlitePath}\0${current.canonicalOwnerSessionKey}`)
        : undefined;
      if (!owner) {
        canonicalKey = current.canonicalKey;
        break;
      }
      current = owner;
    }
    // Resolve each acyclic suffix once, without consuming stack per owner link.
    for (const visited of seen) {
      resolved.set(visited, canonicalKey);
    }
    return canonicalKey;
  };
  const canonicalKeysByStoredKey = new Map<string, Set<string>>();
  for (const item of inventory) {
    item.canonicalKey = resolveCanonicalKey(item);
    const ownerAgentId = parseAgentSessionKey(item.storedKey)?.agentId ?? item.target.agentId;
    // Never synthesize folded aliases from a canonical row: the lowercase peer may be a
    // distinct case-sensitive session whose row was pruned. Only inventoried keys are proof.
    for (const key of [item.sessionKey, item.storedKey]) {
      for (const sqlitePath of [item.target.sqlitePath, "*"]) {
        const mappingKey = `${sqlitePath}\0${ownerAgentId}\0${key}`;
        const mapped = canonicalKeysByStoredKey.get(mappingKey) ?? new Set<string>();
        mapped.add(item.canonicalKey);
        canonicalKeysByStoredKey.set(mappingKey, mapped);
      }
    }
  }
  return canonicalKeysByStoredKey;
}
