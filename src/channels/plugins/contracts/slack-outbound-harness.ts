import { vi, type Mock } from "vitest";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { loadBundledPluginTestApiSync } from "../../../test-utils/bundled-plugin-public-surface.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { primeChannelOutboundSendMock } from "./test-helpers.js";

type OutboundSendMock = Mock<(...args: unknown[]) => Promise<Record<string, unknown>>>;

type SlackOutboundPayloadHarness = {
  run: () => Promise<Record<string, unknown>>;
  sendMock: OutboundSendMock;
  to: string;
};

let slackOutboundCache: ChannelOutboundAdapter | undefined;

function getSlackOutbound(): ChannelOutboundAdapter {
  if (!slackOutboundCache) {
    ({ slackOutbound: slackOutboundCache } = loadBundledPluginTestApiSync<{
      slackOutbound: ChannelOutboundAdapter;
    }>("slack"));
  }
  return slackOutboundCache;
}

export function createSlackOutboundPayloadHarness(params: {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
}): SlackOutboundPayloadHarness {
  const sendSlack: OutboundSendMock = vi.fn();
  primeChannelOutboundSendMock(
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
    run: async () => await getSlackOutbound().sendPayload!(ctx),
    sendMock: sendSlack,
    to: ctx.to,
  };
}
