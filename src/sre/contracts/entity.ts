import crypto from "node:crypto";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EntityId = string;

export const RELATIONSHIP_EDGE_TYPE_VALUES = [
  "alerts_on",
  "belongs_to",
  "calls",
  "defined_in",
  "deploys",
  "depends_on",
  "emits",
  "impacts",
  "owned_by",
  "references",
] as const;

export type RelationshipEdgeType = (typeof RELATIONSHIP_EDGE_TYPE_VALUES)[number];

export const PROVENANCE_ARTIFACT_TYPE_VALUES = [
  "alert",
  "config",
  "grafana_panel",
  "log_line",
  "metric",
  "pr",
  "repo_file",
  "runbook",
  "shell_command",
  "timeline_event",
  "trace",
] as const;

export type ProvenanceArtifactType = (typeof PROVENANCE_ARTIFACT_TYPE_VALUES)[number];

export type ProvenanceRef = {
  version: "sre.provenance-ref.v1";
  artifactType: ProvenanceArtifactType;
  source: string;
  locator: string;
  capturedAt: string;
  title?: string;
  fingerprint?: string;
  attributes?: { [key: string]: JsonValue };
};

export type RelationshipEdge = {
  version: "sre.relationship-edge.v1";
  edgeId: string;
  from: EntityId;
  to: EntityId;
  edgeType: RelationshipEdgeType;
  discoveredAt: string;
  provenance: ProvenanceRef[];
  attributes?: { [key: string]: JsonValue };
};

function stableHash(parts: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 16);
}

export function createEntityId(kind: string, ...parts: readonly string[]): EntityId {
  return `${kind}:${stableHash([kind, ...parts])}`;
}

export function createProvenanceFingerprint(ref: Omit<ProvenanceRef, "version">): string {
  return stableHash([
    ref.artifactType,
    ref.source,
    ref.locator,
    ref.capturedAt,
    ref.title ?? "",
    JSON.stringify(ref.attributes ?? {}),
  ]);
}

export function createRelationshipEdgeId(
  params: Pick<RelationshipEdge, "from" | "to" | "edgeType">,
): string {
  return `edge:${stableHash([params.from, params.edgeType, params.to])}`;
}

export function createProvenanceRef(
  ref: Omit<ProvenanceRef, "fingerprint" | "version"> & { fingerprint?: string },
): ProvenanceRef {
  return {
    version: "sre.provenance-ref.v1",
    ...ref,
    fingerprint: ref.fingerprint ?? createProvenanceFingerprint(ref),
  };
}
