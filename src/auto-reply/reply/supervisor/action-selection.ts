import { getDefaultActionForRelation } from "./taxonomy.js";
import type { SupervisorAction, SupervisorRelation } from "./types.js";

export function selectSupervisorActionFromRelation(
  relation: SupervisorRelation | undefined,
): SupervisorAction {
  if (!relation) {
    return "continue";
  }
  return getDefaultActionForRelation(relation);
}
