import { describe, vi } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import {
  installSendPayloadContractSuite,
  primeSendMock,
} from "../../../test-utils/send-payload-contract.js";
import { slackOutbound } from "./slack.js";

function createHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}) {
  const sendSlack = vi.fn();
  primeSendMock(
    sendSlack,
    { messageId: "sl-1", channelId: "C12345", ts: "1234.5678" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "C12345",
    text: "",
    payload: params.payload,
    deps: {
      sendSlack,
    },
  };
  return {
    run: async () => await slackOutbound.sendPayload!(ctx),
    sendMock: sendSlack,
    to: ctx.to,
  };
}

describe("slackOutbound sendPayload", () => {
  installSendPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness,
  });
});
