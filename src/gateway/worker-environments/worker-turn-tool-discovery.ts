import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createConfiguredSkillWorkshopTool } from "../../agents/tools/skill-workshop-tool-factory.js";
import { getRuntimeConfig, getRuntimeConfigSnapshot } from "../../config/config.js";
import { prepareSessionToolDiscovery } from "../tool-discovery.js";

/** Worker Workshop remains personal-only; its saved declaration grants no library authority. */
export async function prepareWorkerTurnToolDiscovery(
  turn: Pick<
    SessionPlacementTurnParams,
    "config" | "runId" | "skillLibraryAuthoring" | "toolDiscoveryCapture"
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
  return {
    ...discovery,
    codingToolDiscovery: presentation ? { automations: presentation.automations } : undefined,
    createSkillWorkshop: () =>
      turn.skillLibraryAuthoring || presentation?.workshop
        ? createConfiguredSkillWorkshopTool({
            config: turn.config ?? {},
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            runId: turn.runId,
            run: {
              libraryAuthoring: turn.skillLibraryAuthoring
                ? { ...turn.skillLibraryAuthoring, defaultTarget: "personal" }
                : undefined,
              presentation: presentation?.workshop
                ? { ...presentation.workshop, defaultTarget: "personal" }
                : undefined,
            },
          })
        : undefined,
  };
}
