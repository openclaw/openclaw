import type { QueueMode } from "../queue.js";
import type { SupervisorAction, SupervisorClassifierKind, SupervisorRelation } from "./types.js";

export type LegacyQueueTranslation = {
  relation: SupervisorRelation;
  action: SupervisorAction;
  classifierKind: SupervisorClassifierKind;
  rationale: string;
};

export function translateLegacyQueueDecision(mode: QueueMode): LegacyQueueTranslation {
  switch (mode) {
    case "interrupt":
      return {
        relation: "new_task_replace",
        action: "abort_and_replace",
        classifierKind: "legacy_queue_translation",
        rationale: "legacy interrupt maps to replacing the current foreground task",
      };
    case "steer":
    case "steer-backlog":
      return {
        relation: "same_task_correction",
        action: "steer",
        classifierKind: "legacy_queue_translation",
        rationale: "legacy steer modes redirect the current task without replacing it",
      };
    case "followup":
    case "collect":
      return {
        relation: "same_task_supplement",
        action: "append",
        classifierKind: "legacy_queue_translation",
        rationale: "legacy followup and collect map to supplementing the current task",
      };
    case "queue":
      return {
        relation: "background_relevant",
        action: "defer",
        classifierKind: "legacy_queue_translation",
        rationale: "legacy queue mode keeps work relevant without foregrounding it yet",
      };
  }
}
