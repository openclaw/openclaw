import crypto from "node:crypto";
import type { EntityId, ProvenanceRef } from "./entity.js";

export type IncidentDossierTimelineEntry = {
  at: string;
  kind: "bundle" | "change" | "note" | "plan";
  refId: string;
  summary: string;
};

export type IncidentDossierIndex = {
  version: "sre.incident-dossier-index.v1";
  incidentId: string;
  title: string;
  status: "open" | "monitoring" | "resolved";
  updatedAt: string;
  entityIds: EntityId[];
  bundleIds: string[];
  planIds: string[];
  provenance: ProvenanceRef[];
  timeline: IncidentDossierTimelineEntry[];
};

function stableHash(parts: readonly string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u001f");
  }
  return hash.digest("hex").slice(0, 16);
}

export function createIncidentDossierId(
  params: Pick<IncidentDossierIndex, "incidentId" | "updatedAt">,
): string {
  return `dossier:${stableHash([params.incidentId, params.updatedAt])}`;
}

export function createIncidentDossierIndex(
  params: Omit<
    IncidentDossierIndex,
    "bundleIds" | "entityIds" | "planIds" | "timeline" | "version"
  > & {
    bundleIds?: string[];
    entityIds?: EntityId[];
    planIds?: string[];
    timeline?: IncidentDossierTimelineEntry[];
  },
): IncidentDossierIndex {
  return {
    version: "sre.incident-dossier-index.v1",
    ...params,
    entityIds: [...(params.entityIds ?? [])].toSorted(),
    bundleIds: [...(params.bundleIds ?? [])].toSorted(),
    planIds: [...(params.planIds ?? [])].toSorted(),
    timeline: [...(params.timeline ?? [])].toSorted((left, right) =>
      `${left.at}:${left.refId}`.localeCompare(`${right.at}:${right.refId}`),
    ),
  };
}
