import fs from "node:fs/promises";
import {
  readRelationshipIndexLatestSnapshot,
  resolveRelationshipIndexStorePaths,
  type RelationshipIndexNode,
} from "../../plugins/bundled/relationship-index/store.js";
import type { RelationshipEdge } from "../../sre/contracts/entity.js";

export type RelationshipGraphSnapshot = {
  nodes: Record<string, RelationshipIndexNode>;
  edges: RelationshipEdge[];
};

function summarizeProvenanceConfidence(edge: RelationshipEdge): number | undefined {
  const scores = edge.provenance
    .map((item) => item.attributes?.confidence)
    .filter((value): value is number => typeof value === "number");
  if (scores.length === 0) {
    return undefined;
  }
  return Math.max(...scores);
}

export function summarizeEdge(edge: RelationshipEdge) {
  return {
    edgeId: edge.edgeId,
    from: edge.from,
    to: edge.to,
    edgeType: edge.edgeType,
    discoveredAt: edge.discoveredAt,
    confidence: summarizeProvenanceConfidence(edge),
    provenance: edge.provenance.map((item) => ({
      source: item.source,
      locator: item.locator,
      capturedAt: item.capturedAt,
      confidence:
        typeof item.attributes?.confidence === "number" ? item.attributes.confidence : undefined,
    })),
  };
}

export async function loadRelationshipGraphSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RelationshipGraphSnapshot> {
  const latest = await readRelationshipIndexLatestSnapshot(env);
  const edgesPath = resolveRelationshipIndexStorePaths(env).edgesPath;
  let edges: RelationshipEdge[] = [];
  try {
    const raw = await fs.readFile(edgesPath, "utf8");
    edges = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RelationshipEdge);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return {
    nodes: latest?.nodes ?? {},
    edges,
  };
}

export function deriveNeighborEntityId(
  edge: RelationshipEdge,
  entityId: string,
): string | undefined {
  if (edge.from === entityId) {
    return edge.to;
  }
  if (edge.to === entityId) {
    return edge.from;
  }
  return undefined;
}

export function describeEntity(node: RelationshipIndexNode | undefined) {
  if (!node) {
    return undefined;
  }
  return {
    entityId: node.entityId,
    entityType: node.entityType,
    observedAt: node.observedAt,
    attributes: node.attributes,
  };
}
