import crypto from "node:crypto";
import type { EntityId, JsonValue, ProvenanceRef } from "./entity.js";

export const EVIDENCE_SOURCE_VALUES = [
  "argocd",
  "betterstack",
  "change-intel",
  "github",
  "grafana",
  "human",
  "incident-memory",
  "kubernetes",
  "linear",
  "prometheus",
  "runtime",
] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCE_VALUES)[number];

export type EvidenceRow = {
  version: "sre.evidence-row.v1";
  evidenceId: string;
  source: EvidenceSource;
  summary: string;
  observedAt: string;
  entityIds: EntityId[];
  provenance: ProvenanceRef[];
  confidence?: number;
  attributes?: { [key: string]: JsonValue };
};

export type IncidentBundle = {
  version: "sre.incident-bundle.v1";
  bundleId: string;
  incidentId: string;
  title: string;
  status: "open" | "monitoring" | "resolved";
  generatedAt: string;
  sources: EvidenceSource[];
  rows: EvidenceRow[];
  provenance: ProvenanceRef[];
};

export type SpecialistFindingsEnvelope = {
  version: "sre.specialist-findings-envelope.v1";
  envelopeId: string;
  incidentId: string;
  specialistId: string;
  generatedAt: string;
  summary: string;
  evidenceIds: string[];
  provenance: ProvenanceRef[];
};

function stableHash(parts: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 16);
}

export function createEvidenceRowId(
  params: Pick<EvidenceRow, "source" | "summary" | "observedAt" | "entityIds">,
): string {
  return `evidence:${stableHash([
    params.source,
    params.summary,
    params.observedAt,
    ...[...params.entityIds].toSorted(),
  ])}`;
}

export function createIncidentBundleId(
  params: Pick<IncidentBundle, "incidentId" | "generatedAt"> & { evidenceIds: string[] },
): string {
  return `bundle:${stableHash([
    params.incidentId,
    params.generatedAt,
    ...[...params.evidenceIds].toSorted(),
  ])}`;
}

export function createSpecialistFindingsEnvelopeId(
  params: Pick<SpecialistFindingsEnvelope, "incidentId" | "specialistId" | "generatedAt">,
): string {
  return `findings:${stableHash([params.incidentId, params.specialistId, params.generatedAt])}`;
}
