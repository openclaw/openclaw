import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import type { PreparedChatSendAttachments } from "./chat-send-attachments.js";

export function createUserTurnInputController(text = "raw message") {
  const baseInput: UserTurnInput = {
    text,
    timestamp: 1,
    idempotencyKey: "run-1:user",
  };
  let inputPromise = Promise.resolve(baseInput);
  return {
    controller: {
      baseInput,
      setInputPromise: (input: Promise<UserTurnInput>) => {
        inputPromise = input;
      },
    },
    readInput: () => inputPromise,
  };
}

export function createClientInfo(overrides: Partial<GatewayClientInfo> = {}): GatewayClientInfo {
  return {
    id: GATEWAY_CLIENT_IDS.CLI,
    version: "test",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    ...overrides,
  };
}

export function createAttachments(
  overrides: Partial<PreparedChatSendAttachments> = {},
): PreparedChatSendAttachments {
  return {
    explicitOriginTargetsPlugin: false,
    imageOrder: [],
    mediaPathOffloads: [],
    offloadedRefs: [],
    parsedImages: [],
    parsedMessage: "hello",
    prepareAttachmentsMs: undefined,
    ...overrides,
  };
}
