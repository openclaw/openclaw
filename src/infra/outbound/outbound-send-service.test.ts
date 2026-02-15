import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchChannelMessageAction: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../channels/plugins/message-actions.js", () => ({
  dispatchChannelMessageAction: (...args: unknown[]) => mocks.dispatchChannelMessageAction(...args),
}));

vi.mock("./message.js", () => ({
  sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
  sendPoll: vi.fn(),
}));

import { executeSendAction } from "./outbound-send-service.js";

describe("executeSendAction", () => {
  beforeEach(() => {
    mocks.dispatchChannelMessageAction.mockReset();
    mocks.sendMessage.mockReset();
  });

  it("forwards ctx.agentId to sendMessage on core outbound path", async () => {
    mocks.dispatchChannelMessageAction.mockResolvedValue(null);
    mocks.sendMessage.mockResolvedValue({
      channel: "discord",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: {
        cfg: {},
        channel: "discord",
        params: {},
        agentId: "work",
        dryRun: false,
      },
      to: "channel:123",
      message: "hello",
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        channel: "discord",
        to: "channel:123",
        content: "hello",
      }),
    );
  });
});
