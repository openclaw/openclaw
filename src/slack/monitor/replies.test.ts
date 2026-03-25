import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const getGlobalHookRunnerMock = vi.fn();
vi.mock("../send.js", () => ({
  sendMessageSlack: (...args: unknown[]) => sendMock(...args),
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => getGlobalHookRunnerMock(),
}));

import { deliverReplies } from "./replies.js";

function baseParams(overrides?: Record<string, unknown>) {
  return {
    replies: [{ text: "hello" }],
    target: "C123",
    token: "xoxb-test",
    runtime: { log: () => {}, error: () => {}, exit: () => {} },
    textLimit: 4000,
    replyToMode: "off" as const,
    ...overrides,
  };
}

describe("deliverReplies identity passthrough", () => {
  beforeEach(() => {
    sendMock.mockReset();
    getGlobalHookRunnerMock.mockReset();
    getGlobalHookRunnerMock.mockReturnValue(null);
  });
  it("passes identity to sendMessageSlack for text replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconEmoji: ":robot:" };
    await deliverReplies(baseParams({ identity }));

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("passes identity to sendMessageSlack for media replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const identity = { username: "Bot", iconUrl: "https://example.com/icon.png" };
    await deliverReplies(
      baseParams({
        identity,
        replies: [{ text: "caption", mediaUrls: ["https://example.com/img.png"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ identity });
  });

  it("omits identity key when not provided", async () => {
    sendMock.mockResolvedValue(undefined);
    await deliverReplies(baseParams());

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).not.toHaveProperty("identity");
  });

  it("passes mediaLocalRoots to sendMessageSlack", async () => {
    sendMock.mockResolvedValue(undefined);
    const mediaLocalRoots = ["/tmp/workspace-sre"];
    await deliverReplies(
      baseParams({
        mediaLocalRoots,
        replies: [{ text: "report", mediaUrls: ["/tmp/workspace-sre/report.csv"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][2]).toMatchObject({ mediaLocalRoots });
  });

  it("runs message_sending hooks before sending monitor replies", async () => {
    sendMock.mockResolvedValue(undefined);
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ content: "*Incident:* ok" }),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner);

    await deliverReplies(baseParams({ replyThreadTs: "1111.2222" }));

    expect(hookRunner.hasHooks).toHaveBeenCalledWith("message_sending");
    expect(hookRunner.runMessageSending).toHaveBeenCalledWith(
      {
        to: "C123",
        content: "hello",
        metadata: { threadTs: "1111.2222", channelId: "C123" },
      },
      { channelId: "slack", accountId: undefined },
    );
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      "*Incident:* ok",
      expect.objectContaining({ threadTs: "1111.2222" }),
    );
  });

  it("drops monitor replies canceled by message_sending hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ cancel: true }),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner);

    const deliveredCount = await deliverReplies(baseParams({ replyThreadTs: "1111.2222" }));

    expect(sendMock).not.toHaveBeenCalled();
    expect(deliveredCount).toBe(0);
  });

  it("passes bare Slack channel ids to hooks when the target has a channel prefix", async () => {
    sendMock.mockResolvedValue(undefined);
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runMessageSending: vi.fn().mockResolvedValue({ content: "*Incident:* ok" }),
    };
    getGlobalHookRunnerMock.mockReturnValue(hookRunner);

    await deliverReplies(
      baseParams({
        target: "channel:C123",
        replyThreadTs: "1111.2222",
      }),
    );

    expect(hookRunner.runMessageSending).toHaveBeenCalledWith(
      {
        to: "channel:C123",
        content: "hello",
        metadata: { threadTs: "1111.2222", channelId: "C123" },
      },
      { channelId: "slack", accountId: undefined },
    );
  });

  it("returns zero when the payload resolves to an exact silent token", async () => {
    sendMock.mockResolvedValue(undefined);

    const deliveredCount = await deliverReplies(
      baseParams({
        replies: [{ text: "NO_REPLY" }],
      }),
    );

    expect(sendMock).not.toHaveBeenCalled();
    expect(deliveredCount).toBe(0);
  });

  it("blanks silent token captions for media replies", async () => {
    sendMock.mockResolvedValue(undefined);

    const deliveredCount = await deliverReplies(
      baseParams({
        replies: [{ text: "NO_REPLY", mediaUrls: ["https://example.com/report.png"] }],
      }),
    );

    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock).toHaveBeenCalledWith(
      "C123",
      "",
      expect.objectContaining({ mediaUrl: "https://example.com/report.png" }),
    );
    expect(deliveredCount).toBe(1);
  });
});
