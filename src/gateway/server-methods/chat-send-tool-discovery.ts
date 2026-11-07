import { prepareGatewaySkillLibraryTurn } from "../skill-library-authoring.js";
import { captureGatewayToolDiscovery } from "../tool-discovery.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import type { ChatSendDiagnostics } from "./chat-send-diagnostics.js";

/** Prepares this turn's library grant, then captures the presentation it saves for the conversation. */
export async function prepareChatSendSkillLibraryTurn(
  skillLibrary: StartChatDispatchParams["skillLibrary"],
  prepareSessionCreation: Parameters<typeof prepareGatewaySkillLibraryTurn>[1],
  assertWorkAdmissionCurrent: () => void,
  phase: ReturnType<ChatSendDiagnostics["scope"]>,
) {
  phase?.mark("preparation");
  const skillLibraryAuthoring = await prepareGatewaySkillLibraryTurn(
    skillLibrary,
    prepareSessionCreation,
    () => phase?.mark("authoring"),
  );
  assertWorkAdmissionCurrent();
  const toolDiscoveryCapture = captureGatewayToolDiscovery(
    { ...skillLibrary.owner, sessionMutationCommitGuard: assertWorkAdmissionCurrent },
    skillLibrary.isHumanTurn,
    skillLibraryAuthoring,
  );
  phase?.mark("preparation");
  return { skillLibraryAuthoring, toolDiscoveryCapture };
}
