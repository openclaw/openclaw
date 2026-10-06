import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { LoadedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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
