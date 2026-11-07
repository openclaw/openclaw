import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createSkillLibraryTool } from "../../agents/tools/skill-library-tool.js";
import { getRuntimeConfig, getRuntimeConfigSnapshot } from "../../config/config.js";
import { resolvePresentedSkillLibraryAuthoring } from "../../skills/library/presented-authoring.js";
import { prepareSessionToolDiscovery } from "../tool-discovery.js";

/** Worker library authoring remains personal-only; its saved shape grants no library authority. */
export async function prepareWorkerTurnToolDiscovery(
  turn: Pick<
    SessionPlacementTurnParams,
    "config" | "skillLibraryAuthoring" | "toolDiscoveryCapture"
  >,
  target: BoundAgentRunSessionTarget,
  assertCurrent: () => void,
) {
  const discovery = await prepareSessionToolDiscovery({
    ...target,
    capture: turn.toolDiscoveryCapture,
    getConfig: () => getRuntimeConfigSnapshot() ?? turn.config ?? getRuntimeConfig(),
    assertCurrent,
  });
  const presentation = discovery.presentation;
  // Worker turns author only the personal library, never Workshop.
  const skillLibraryAuthoring = resolvePresentedSkillLibraryAuthoring(
    turn.skillLibraryAuthoring && { ...turn.skillLibraryAuthoring, defaultTarget: "personal" },
    presentation?.workshop && { ...presentation.workshop, defaultTarget: "personal" },
  );
  return {
    ...discovery,
    codingToolDiscovery: presentation ? { automations: presentation.automations } : undefined,
    skillLibraryAuthoring,
    skillLibrary: skillLibraryAuthoring && createSkillLibraryTool(skillLibraryAuthoring),
  };
}
