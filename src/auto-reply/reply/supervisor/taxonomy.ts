import SUPERVISOR_TAXONOMY_JSON from "./taxonomy.v1.json" with { type: "json" };
import type { SupervisorAction, SupervisorRelation, SupervisorTaxonomy } from "./types.js";

export const SUPERVISOR_TAXONOMY = SUPERVISOR_TAXONOMY_JSON as SupervisorTaxonomy;
export const SUPERVISOR_TAXONOMY_VERSION = SUPERVISOR_TAXONOMY.version;

export function getSupervisorTaxonomy(): SupervisorTaxonomy {
  return SUPERVISOR_TAXONOMY;
}

export function getSupervisorRelationDefinition(relation: SupervisorRelation) {
  return SUPERVISOR_TAXONOMY.relations.find((entry) => entry.id === relation);
}

export function getDefaultActionForRelation(relation: SupervisorRelation): SupervisorAction {
  return getSupervisorRelationDefinition(relation)?.defaultActionCandidates[0] ?? "continue";
}
