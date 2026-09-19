import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";

export function buildSkillWorkshopToolDescription(params: {
  autonomousMode: "off" | "propose" | "auto";
  proposalRevision: boolean;
}): string {
  if (params.proposalRevision) {
    return `Inspect and revise only the proposal revision selected by the operator. The proposal id and expected revision hash are bound by the run and cannot be replaced by tool arguments. Never apply, reject, quarantine, or create another proposal.\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
  }
  const repairPolicy =
    params.autonomousMode === "off"
      ? "Foreground repair is disabled."
      : params.autonomousMode === "propose"
        ? "A foreground patch to a skill used in this run stays pending for review."
        : "A foreground patch to a skill used in this run is scanned and applied immediately.";
  return `${SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY} Stage pending proposals to create or update reusable-procedure skills in your agent's Workshop directory. Create and update do not publish or activate skills; a later apply step makes the proposal active. Read, prepare an exact bounded patch, patch, revise, inspect, evaluate, and apply Workshop proposals. The operator edits all other skills directly. Restore a retained backup from the previous collection-review implementation when the user asks. New reviews use automation history and do not create collection backups. Important: read and prepare_patch only inspect a skill or authorize an exact patch span; they do not count as using the skill and do not authorize foreground repair. A foreground patch is allowed only when a separate usage receipt shows that the skill was used in this run. If that receipt is absent, use action=update for a complete-body pending proposal after a complete read, or ask the operator to edit the skill; do not repeat read or prepare_patch to manufacture repair authority. ${repairPolicy}\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
}
