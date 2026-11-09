import type { SessionAcpMeta, SessionEntry } from "../../config/sessions/types.js";
import { annotateInterSessionPromptText } from "../../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../restart-recovery-prompt.js";
import { isSubagentSessionFromEntry } from "../subagents/spawn/subagent-depth-policy.js";

export function prepareSessionsSendPrompt(params: {
  message: string;
  requesterSessionKey?: string;
  requesterChannel?: string;
  requesterIsSubagent: boolean;
  targetSessionKey: string;
  targetSessionEntry?: SessionEntry;
  targetAcpMeta?: SessionAcpMeta;
}) {
  const inputProvenance = {
    kind: "inter_session" as const,
    sourceSessionKey: params.requesterSessionKey,
    sourceChannel: params.requesterChannel,
    sourceTool: "sessions_send",
    ...(params.requesterIsSubagent ? { sourceRole: "subagent" as const } : {}),
  };
  let dispatchMessage = annotateInterSessionPromptText(params.message, inputProvenance);
  if (
    !params.targetAcpMeta &&
    params.targetSessionEntry?.status === "interrupted" &&
    isSubagentSessionFromEntry(params.targetSessionKey, params.targetSessionEntry)
  ) {
    dispatchMessage = `${formatSystemTurnPrompt(RESTART_RECOVERY_INTERRUPTION_NOTE)}\n\n${dispatchMessage}`;
  }
  return { inputProvenance, dispatchMessage };
}
