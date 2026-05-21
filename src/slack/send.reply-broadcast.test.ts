import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageSlack } from "./send.js";

const originalSlackBotToken = process.env.SLACK_BOT_TOKEN;

afterEach(() => {
  if (originalSlackBotToken === undefined) {
    delete process.env.SLACK_BOT_TOKEN;
  } else {
    process.env.SLACK_BOT_TOKEN = originalSlackBotToken;
  }
});

describe("sendMessageSlack reply broadcast", () => {
  it("sets reply_broadcast only when posting into a Slack thread", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const postMessage = vi.fn().mockResolvedValue({ ts: "333.444" });
    const client = {
      chat: { postMessage },
    };

    await sendMessageSlack("C123", "hello", {
      client: client as never,
      threadTs: "111.222",
      replyBroadcast: true,
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "hello",
        thread_ts: "111.222",
        reply_broadcast: true,
      }),
    );

    postMessage.mockClear();
    await sendMessageSlack("C123", "hello", {
      client: client as never,
      replyBroadcast: true,
    });

    expect(postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ reply_broadcast: true }),
    );
  });
});
