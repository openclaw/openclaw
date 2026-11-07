import { resolveTurnCyberAccessProgram } from "../../agents/model-catalog-access-programs.js";
import { isSyntheticSourceReplyTurn } from "../../agents/reply-completion.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

/** Direct chats learn once that a saved Daybreak choice did not apply to a non-OpenAI reply. */
export function appendCyberAccessProgramNotice(
  noticeText: string | null,
  context: FinalizeReplyAgentRunInput,
  accounting: AccountedAgentTurn,
): string | null {
  const { followupRun, sessionCtx, sessionKey } = context;
  const chatType = normalizeChatType(sessionCtx.ChatType);
  let notice: string | undefined;
  resolveTurnCyberAccessProgram({
    program: followupRun.run.cyberAccessProgram,
    provider: accounting.providerUsed,
    model: accounting.modelUsed,
    noticeScope: `reply:${sessionKey ?? followupRun.run.sessionId}`,
    ...(context.execution.status === "ok" &&
    accounting.runResult.meta?.aborted !== true &&
    !accounting.preserveUserFacingSessionState &&
    followupRun.currentInboundEventKind !== "room_event" &&
    !isSyntheticSourceReplyTurn({
      inputProvenance: followupRun.run.inputProvenance,
      scheduledAutomation: followupRun.run.scheduledAutomation !== undefined,
    }) &&
    chatType !== "group" &&
    chatType !== "channel"
      ? { notify: (text: string) => (notice = text) }
      : {}),
  });
  return notice ? (noticeText ? `${noticeText}\n\n${notice}` : notice) : noticeText;
}
