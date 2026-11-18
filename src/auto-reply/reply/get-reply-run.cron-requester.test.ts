import { expect, it } from "vitest";
import { resolveReplyCronChannelRequester } from "./get-reply-run.cron-requester.js";

it("captures Telegram's native sender and ingress account, never a reply account", () => {
  expect(
    resolveReplyCronChannelRequester({
      channel: "telegram",
      senderId: "123",
      accountId: "work",
      replyAccountId: "other",
    }),
  ).toEqual({ version: 1, channel: "telegram", accountId: "work", senderId: "123" });
  expect(
    resolveReplyCronChannelRequester({
      channel: "telegram",
      senderId: "123",
      replyAccountId: "other",
    })?.accountId,
  ).toBe("default");
});

it.each([undefined, "", "   "])("rejects missing or blank native sender %s", (senderId) => {
  expect(
    resolveReplyCronChannelRequester({ channel: "telegram", accountId: "work", senderId }),
  ).toBeUndefined();
});

it("preserves the Discord account contract and does not enroll other channels", () => {
  expect(
    resolveReplyCronChannelRequester({
      channel: "discord",
      senderId: "123",
      accountId: "ingress",
      replyAccountId: "work",
    }),
  ).toEqual({ version: 1, channel: "discord", accountId: "work", senderId: "123" });
  expect(resolveReplyCronChannelRequester({ channel: "webchat", senderId: "123" })).toBeUndefined();
});
