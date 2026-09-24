import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";

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
  overrides: Partial<{
    explicitOriginTargetsPlugin: boolean;
    mediaPathOffloads: MediaFact[];
    imageOrder: Array<"inline" | "offloaded">;
    parsedImages: Array<{
      type: "image";
      data: string;
      mimeType: string;
      sourceIndex: number;
    }>;
    offloadedRefs: Array<{
      mediaRef: string;
      id: string;
      path: string;
      sourceIndex: number;
      kind: "image" | "audio" | "video" | "document" | "sticker" | "unknown";
      mimeType: string;
      label: string;
      sizeBytes: number;
    }>;
    parsedMessage: string;
  }> = {},
) {
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
