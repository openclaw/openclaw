import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { LoadedChatSendSession, PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions, SessionMutationAuthorization } from "./types.js";

export type ChatSendPreAdmissionParams = {
  assertCurrentAsync?: () => Promise<void>;
  withCurrent?: <T>(consume: () => T) => Promise<T>;
  request: NormalizedChatSendRequest;
  session: LoadedChatSendSession;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  assertCurrent?: () => void;
};

export type ChatSendAdmissionParams = ChatSendPreAdmissionParams & {
  session: PreparedChatSendSession;
  withPreparedCurrent?: SessionMutationAuthorization["withPreparedCurrent"];
  hasCurrentClientAuthority?: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
  onAdmissionOwned?: () => Promise<boolean>;
};
