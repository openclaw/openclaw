import { expect, it } from "vitest";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../../channels/message-access/host-ingress.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { resolveReplyCronChannelRequester } from "./get-reply-run.cron-requester.js";

it.each(["default", "work"])(
  "captures a configured Telegram owner through the real host ingress (%s)",
  (accountId) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const host = createHostIngressFixture("telegram", {
        commands: { ownerAllowFrom: ["telegram:123"] },
      });
      try {
        const message = ingressMessage("telegram", "agent:main:telegram:direct:123", "123", {
          accountId: accountId === "default" ? undefined : accountId,
        });
        const channelIngress = await host.ingress.resolveStable(
          ingressInput(message, { identity: { authentication: "verified" } }),
        );
        const context = host.buildContext({ ...message, channelIngress });
        const authority = getCommandOwnerAuthority(context);
        expect(authority?.isCurrent()).toBe(true);
        expect(authority?.channelPrincipal).toEqual({
          channelId: "telegram",
          accountId,
          senderId: "123",
        });
        const params = {
          channel: "telegram",
          senderId: "123",
          accountId: accountId === "default" ? undefined : accountId,
          replyAccountId: "other",
        };
        expect(resolveReplyCronChannelRequester(context, params)).toEqual({
          version: 1,
          channel: "telegram",
          accountId,
          senderId: "123",
        });
        expect(
          resolveReplyCronChannelRequester(context, { ...params, accountId: "other" }),
        ).toBeUndefined();
        expect(
          resolveReplyCronChannelRequester(context, { ...params, senderId: "other" }),
        ).toBeUndefined();
        host.retire();
        expect(resolveReplyCronChannelRequester(context, params)).toBeUndefined();
      } finally {
        host.retire();
      }
    }),
);

it.each([undefined, "", "   ", "123"])("rejects an unbound Telegram sender %s", (senderId) => {
  expect(
    resolveReplyCronChannelRequester({}, { channel: "telegram", accountId: "work", senderId }),
  ).toBeUndefined();
});

it("preserves the Discord account contract and does not enroll other channels", () => {
  expect(
    resolveReplyCronChannelRequester(
      {},
      { channel: "discord", senderId: "123", accountId: "ingress", replyAccountId: "work" },
    ),
  ).toEqual({ version: 1, channel: "discord", accountId: "work", senderId: "123" });
  expect(
    resolveReplyCronChannelRequester({}, { channel: "webchat", senderId: "123" }),
  ).toBeUndefined();
});
