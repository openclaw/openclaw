import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendWebhookMessageDiscord } from "./send.js";

const recordChannelActivityMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/channel-activity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/channel-activity.js")>();
  return {
    ...actual,
    recordChannelActivity: (...args: unknown[]) => recordChannelActivityMock(...args),
  };
});

describe("sendWebhookMessageDiscord activity", () => {
  beforeEach(() => {
    recordChannelActivityMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ id: "msg-1", channel_id: "thread-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records outbound channel activity for webhook sends", async () => {
    const result = await sendWebhookMessageDiscord("hello world", {
      webhookId: "wh-1",
      webhookToken: "tok-1",
      accountId: "runtime",
      threadId: "thread-1",
    });

    expect(result).toEqual({
      messageId: "msg-1",
      channelId: "thread-1",
    });
    expect(recordChannelActivityMock).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "runtime",
      direction: "outbound",
    });
  });
});
