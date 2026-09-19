import type { IncomingMessage } from "node:http";
import { resolveGatewayRequestContext } from "./http-utils.js";

/**
 * Chat Completions treats OpenAI `user` as request metadata, not a durable
 * session owner. Bind only an explicit x-openclaw-session-key.
 */
export function resolveOpenAiChatGatewayRequestContext(params: {
  req: IncomingMessage;
  model: string | undefined;
  user?: string;
}) {
  return resolveGatewayRequestContext({
    req: params.req,
    model: params.model,
    user: params.user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
    bindUserToSession: false,
  });
}
