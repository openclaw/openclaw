export type NodeMatchCandidate = {
  nodeId: string;
  displayName?: string;
  remoteIp?: string;
  connected?: boolean;
  clientId?: string;
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

function formatNodeCandidateLabel(node: NodeMatchCandidate): string {
  const label = node.displayName || node.remoteIp || node.nodeId;
  const details = [`node=${node.nodeId}`];
  if (typeof node.clientId === "string" && node.clientId.trim()) {
    details.push(`client=${node.clientId.trim()}`);
  }
  return `${label} [${details.join(", ")}]`;
}

function isCurrentOpenClawClient(clientId: string | undefined): boolean {
  const normalized = clientId?.trim().toLowerCase() ?? "";
  return normalized.startsWith("openclaw-");
}

function isLegacyClawdbotClient(clientId: string | undefined): boolean {
  const normalized = clientId?.trim().toLowerCase() ?? "";
  return normalized.startsWith("clawdbot-") || normalized.startsWith("moldbot-");
}

function pickPreferredLegacyMigrationMatch(
  matches: NodeMatchCandidate[],
): NodeMatchCandidate | undefined {
  const current = matches.filter((match) => isCurrentOpenClawClient(match.clientId));
  if (current.length !== 1) {
    return undefined;
  }
  const legacyCount = matches.filter((match) => isLegacyClawdbotClient(match.clientId)).length;
  if (legacyCount === 0 || current.length + legacyCount !== matches.length) {
    return undefined;
  }
  return current[0];
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

  const rawMatches = resolveNodeMatches(nodes, q);
  if (rawMatches.length === 1) {
    return rawMatches[0]?.nodeId ?? "";
  }
  if (rawMatches.length === 0) {
    const known = listKnownNodes(nodes);
    throw new Error(`unknown node: ${q}${known ? ` (known: ${known})` : ""}`);
  }

  // Re-pair/reinstall flows can leave multiple nodes with the same display name.
  // Prefer a unique connected match when available.
  const connectedMatches = rawMatches.filter((match) => match.connected === true);
  const matches = connectedMatches.length > 0 ? connectedMatches : rawMatches;
  if (matches.length === 1) {
    return matches[0]?.nodeId ?? "";
  }

  const preferred = pickPreferredLegacyMigrationMatch(matches);
  if (preferred) {
    return preferred.nodeId;
  }

  throw new Error(
    `ambiguous node: ${q} (matches: ${matches.map(formatNodeCandidateLabel).join(", ")})`,
  );
}
