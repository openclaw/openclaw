// Leaf contract for supervised-root admission: the slice of prepareAgentRunDispatch params the
// root helper reads. Kept apart so the admission phase and the helper never import each other.
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { registerChatAbortController } from "../chat-abort.js";
import type { ChatImageContent, OffloadedRef } from "../chat-attachments.js";
import type { AgentTurnContext, AgentTurnIo } from "./types.js";

export type SupervisedRootRunAbort = ReturnType<typeof registerChatAbortController>;

export type SupervisedRootAdmission = {
  cfg: OpenClawConfig;
  activeSessionAgentId: string;
  resolvedSessionKey?: string;
  suppressVisibleSessionEffects: boolean;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  canUseInternalRuntimeHandoff: boolean;
  sessionEntry?: SessionEntry;
  inputProvenance?: InputProvenance;
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  assertAdmissionCurrent?: () => void;
  assertGatewayWorkAdmissionAllowed: () => void;
  lifecycleGeneration: string;
  getAdmittedSessionId: () => string;
  runId: string;
  markAgentRunAccepted: (accepted: boolean) => void;
  context: AgentTurnContext;
  agentDedupeKeys: readonly string[];
  io: AgentTurnIo;
};
