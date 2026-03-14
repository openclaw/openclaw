import { describe, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../test-utils/send-payload-contract.js";
import { createDirectTextMediaOutbound } from "./direct-text-media.js";

function createDirectHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  const sendFn = vi.fn();
  primeSendMock(sendFn, { messageId: "m1" }, params.sendResults);
  const outbound = createDirectTextMediaOutbound({
    channel: "imessage",
    resolveSender: () => sendFn,
    resolveMaxBytes: () => undefined,
    buildTextOptions: (opts) => opts as never,
    buildMediaOptions: (opts) => opts as never,
  });
  return { outbound, sendFn };
}

function baseCtx(payload: ReplyPayload) {
  return {
    cfg: {},
    to: "user1",
    text: "",
    payload,
  };
}

describe("createDirectTextMediaOutbound sendPayload", () => {
  installSendPayloadContractSuite({
    channel: "imessage",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: ({ payload, sendResults }) => {
      const { outbound, sendFn } = createDirectHarness({ payload, sendResults });
      return {
        run: async () => await outbound.sendPayload!(baseCtx(payload)),
        sendMock: sendFn,
        to: "user1",
      };
    },
  });
});
