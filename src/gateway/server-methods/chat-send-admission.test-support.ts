import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { prepareChatSendSession, qualifyChatSendSession } from "./chat-send-session.js";

type Preparation = Omit<Parameters<typeof prepareChatSendSession>[0], "request"> &
  Pick<Parameters<typeof normalizeChatSendRequest>[0], "params">;

export async function prepareChatAdmission({ params, ...options }: Preparation) {
  const request = await normalizeChatSendRequest({ params, client: options.client });
  if (!request.ok) {
    throw new Error(request.error);
  }
  const prepared = await prepareChatSendSession({ ...options, request: request.value });
  if (!prepared.ok) {
    throw new Error("Session preparation failed");
  }
  return {
    request: request.value,
    prepared: prepared.value,
    session: await qualifyChatSendSession(prepared.value),
  };
}

export async function prepareAuthorizedChatAdmission(options: Preparation) {
  const prepared = await prepareChatAdmission(options);
  const resolved = await resolveSessionMutationAuthorizationAsync({
    client: options.client,
    method: "chat.send",
    requestParams: options.params,
    context: options.context,
  });
  const authorization = resolved.authorization;
  if (resolved.error || !authorization?.withCurrent) {
    throw new Error("Expected retained worker authorization");
  }
  return { ...prepared, authorization, authorizationError: resolved.error };
}
