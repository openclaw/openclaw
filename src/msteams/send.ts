import type { MSTeamsConfig } from "../config/types.js";
import { getChildLogger } from "../logging.js";

const log = getChildLogger({ name: "msteams:send" });

export type SendMSTeamsMessageParams = {
  cfg: MSTeamsConfig;
  conversationId: string;
  text: string;
  serviceUrl: string;
};

export type SendMSTeamsMessageResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export async function sendMessageMSTeams(
  _params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  // TODO: Implement using CloudAdapter.continueConversationAsync
  log.warn("sendMessageMSTeams not yet implemented");
  return { ok: false, error: "not implemented" };
}
