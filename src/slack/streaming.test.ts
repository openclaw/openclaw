import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { startSlackStream, stopSlackStream } from "./streaming.js";

describe("startSlackStream", () => {
  it("passes recipient ids to chatStream", async () => {
    const streamer = {
      append: vi.fn(),
      stop: vi.fn(),
    };
    const chatStream = vi.fn().mockReturnValue(streamer);
    const client = {
      chatStream,
    } as unknown as WebClient;

    await startSlackStream({
      client,
      channelId: "C123",
      threadTs: "1730.1",
      recipientTeamId: "T123",
      recipientUserId: "U123",
    });

    expect(chatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        thread_ts: "1730.1",
        recipient_team_id: "T123",
        recipient_user_id: "U123",
      }),
    );
  });
});

describe("stopSlackStream", () => {
  it("does not throw when Slack rejects stop", async () => {
    const streamer = {
      append: vi.fn(),
      stop: vi.fn().mockRejectedValue(new Error("stop failed")),
    };
    const chatStream = vi.fn().mockReturnValue(streamer);
    const client = {
      chatStream,
    } as unknown as WebClient;

    const session = await startSlackStream({
      client,
      channelId: "C123",
      threadTs: "1730.2",
      recipientTeamId: "T123",
      recipientUserId: "U123",
    });

    await expect(stopSlackStream({ session })).resolves.toBeUndefined();
    expect(streamer.stop).toHaveBeenCalledTimes(1);
  });
});
