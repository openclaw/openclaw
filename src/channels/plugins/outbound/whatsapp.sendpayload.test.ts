import { describe, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../test-utils/send-payload-contract.js";
import { whatsappOutbound } from "./whatsapp.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  const sendWhatsApp = vi.fn();
  primeSendMock(sendWhatsApp, { messageId: "wa-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "5511999999999@c.us",
    text: "",
    payload: params.payload,
    deps: {
      sendWhatsApp,
    },
  };
  return {
    run: async () => await whatsappOutbound.sendPayload!(ctx),
    sendMock: sendWhatsApp,
    to: ctx.to,
  };
}

describe("whatsappOutbound sendPayload", () => {
  installSendPayloadContractSuite({
    channel: "whatsapp",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness,
  });
});
