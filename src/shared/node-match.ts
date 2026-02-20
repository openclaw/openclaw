export type NodeMatchCandidate = {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
};

export function normalizeNodeKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function listKnownNodes(nodes: NodeMatchCandidate[]): string {
  return nodes
    .map((n) => n.displayName || n.remoteIp || n.nodeId)
    .filter(Boolean)
    .join(", ");
}

export function resolveNodeMatches(
  nodes: NodeMatchCandidate[],
  query: string,
): NodeMatchCandidate[] {
  const q = query.trim();
  if (!q) {
    return [];
  }

  const qNorm = normalizeNodeKey(q);
  return nodes.filter((n) => {
    if (n.nodeId === q) {
      return true;
    }
    if (typeof n.remoteIp === "string" && n.remoteIp === q) {
      return true;
    }
    const name = typeof n.displayName === "string" ? n.displayName : "";
    if (name && normalizeNodeKey(name) === qNorm) {
      return true;
    }
    if (q.length >= 6 && n.nodeId.startsWith(q)) {
      return true;
    }
    return false;
  });
}

export function resolveNodeIdFromCandidates(nodes: NodeMatchCandidate[], query: string): string {
  const q = query.trim();
  if (!q) {
    throw new Error("node required");
  }

  const matches = resolveNodeMatches(nodes, q);
  if (matches.length === 1) {
    return matches[0]?.nodeId ?? "";
  }
  if (matches.length === 0) {
    const known = listKnownNodes(nodes);
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }
  throw new Error(
    `ambiguous node: ${q} (matches: ${matches
      .map((n) => n.displayName || n.remoteIp || n.nodeId)
      .join(", ")})`,
  );
}
