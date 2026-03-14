import { describe, expect, it, vi } from "vitest";
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

  it("forwards Slack blocks from channelData", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        text: "Fallback summary",
        channelData: {
          slack: {
            blocks: [{ type: "divider" }],
          },
        },
      },
    });

    const result = await run();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      to,
      "Fallback summary",
      expect.objectContaining({
        blocks: [{ type: "divider" }],
      }),
    );
    expect(result).toMatchObject({ channel: "slack", messageId: "sl-1" });
  });

  it("accepts blocks encoded as JSON strings in Slack channelData", async () => {
    const { run, sendMock, to } = createHarness({
      payload: {
        channelData: {
          slack: {
            blocks: '[{"type":"section","text":{"type":"mrkdwn","text":"hello"}}]',
          },
        },
      },
    });

    await run();

    expect(sendMock).toHaveBeenCalledWith(
      to,
      "",
      expect.objectContaining({
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }],
      }),
    );
  });

  it("rejects invalid Slack blocks from channelData", async () => {
    const { run, sendMock } = createHarness({
      payload: {
        channelData: {
          slack: {
            blocks: {},
          },
        },
      },
    });

    await expect(run()).rejects.toThrow(/blocks must be an array/i);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
