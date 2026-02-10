import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageDiscordMock = vi.fn(async () => ({
  messageId: "msg-1",
  channelId: "c1",
}));

vi.mock("../send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.js")>();
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => sendMessageDiscordMock(...args),
  };
});

const isRecoveringMock = vi.fn(() => false);
const queueDeliveryMock = vi.fn(() => false);

vi.mock("../recovery-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../recovery-state.js")>();
  return {
    ...actual,
    isRecovering: (...args: unknown[]) => isRecoveringMock(...args),
    queueDelivery: (...args: unknown[]) => queueDeliveryMock(...args),
  };
});

const { deliverDiscordReply } = await import("./reply-delivery.js");

describe("deliverDiscordReply recovery", () => {
  const baseParams = {
    replies: [{ text: "hello" }],
    target: "discord:channel:123",
    token: "token",
    accountId: "default",
    runtime: { log: () => {}, error: () => {} },
    textLimit: 2000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    isRecoveringMock.mockReturnValue(false);
    queueDeliveryMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("sends when not recovering", async () => {
    await deliverDiscordReply(baseParams);

    expect(sendMessageDiscordMock).toHaveBeenCalled();
    expect(queueDeliveryMock).not.toHaveBeenCalled();
  });

  it("queues and does not send when recovering", async () => {
    isRecoveringMock.mockReturnValue(true);
    queueDeliveryMock.mockReturnValue(true);

    await deliverDiscordReply(baseParams);

    expect(sendMessageDiscordMock).not.toHaveBeenCalled();
    expect(queueDeliveryMock).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        target: "discord:channel:123",
        replies: [{ text: "hello" }],
        accountId: "default",
      }),
    );
  });

  it("sends when recovering but queueDelivery returns false", async () => {
    isRecoveringMock.mockReturnValue(true);
    queueDeliveryMock.mockReturnValue(false);

    await deliverDiscordReply(baseParams);

    expect(sendMessageDiscordMock).toHaveBeenCalled();
    expect(queueDeliveryMock).toHaveBeenCalled();
  });
});
