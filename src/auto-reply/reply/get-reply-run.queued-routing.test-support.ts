import { expect, it } from "vitest";
import type { runPreparedReply } from "./get-reply-run.js";
import { createPreparedReplyTurn as turn } from "./get-reply-run.test-support.js";
import type { FollowupRun } from "./queue.js";

export function registerQueuedReplyRoutingCases(
  prepare: (overrides: Partial<Parameters<typeof runPreparedReply>[0]>) => Promise<FollowupRun>,
) {
  it("captures the prepared reply policy for queued Slack runs", async () => {
    const queued = await prepare({
      cfg: { session: {}, agents: { defaults: {} }, channels: { slack: { replyToMode: "all" } } },
      ...turn(
        "",
        {
          ThreadHistoryBody: "Earlier message in this thread",
          Provider: "slack",
          OriginatingTo: "C123",
          ChatType: "group",
          ReplyToMode: "off",
          ReplyThreading: { implicitCurrentMessage: "deny" },
        },
        { media: [{ path: "/tmp/input.png" }], OriginatingChannel: "slack", ReplyToId: "101.001" },
        { OriginatingChannel: undefined },
      ),
    });

    expect(queued).toMatchObject({
      originatingReplyToId: "101.001",
      originatingReplyToMode: "off",
      originatingReplyThreading: { implicitCurrentMessage: "deny" },
    });
  });

  it("records WebChat as the source of the message ID when queued output routes to Telegram", async () => {
    const queued = await prepare({
      ...turn("send to Telegram", {
        Provider: "webchat",
        Surface: "webchat",
        MessageSid: "gateway-id",
        OriginatingChannel: "telegram",
        OriginatingTo: "123",
      }),
    });
    expect(queued).toMatchObject({
      messageId: "gateway-id",
      messageIdChannel: "webchat",
      originatingChannel: "telegram",
    });
  });
}
