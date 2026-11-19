import { expect, it } from "vitest";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../../channels/message-access/host-ingress.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { resolveReplyCronChannelRequester } from "./get-reply-run.cron-requester.js";

it.each(
  ["telegram", "discord", "slack"].flatMap((channel) =>
    ["default", "work"].map((accountId) => ({ channel, accountId })),
  ),
)(
  "captures a configured $channel owner through the real host ingress ($accountId)",
  ({ channel, accountId }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const host = createHostIngressFixture(channel, {
        commands: { ownerAllowFrom: [`${channel}:123`] },
      });
      try {
        const message = ingressMessage(channel, `agent:main:${channel}:direct:123`, "123", {
          accountId: accountId === "default" ? undefined : accountId,
        });
        const channelIngress = await host.ingress.resolveStable(
          ingressInput(message, { identity: { authentication: "verified" } }),
        );
        const context = host.buildContext({ ...message, channelIngress });
        const authority = getCommandOwnerAuthority(context);
        expect(authority?.isCurrent()).toBe(true);
        expect(authority?.channelPrincipal).toEqual({
          channelId: channel,
          accountId,
          senderId: "123",
        });
        const params = {
          channel,
          senderId: "123",
          accountId: accountId === "default" ? undefined : accountId,
          replyAccountId: "other",
        };
        expect(resolveReplyCronChannelRequester(context, params)).toEqual({
          version: 1,
          channel,
          accountId,
          senderId: "123",
        });
        expect(
          resolveReplyCronChannelRequester(context, { ...params, accountId: "other" }),
        ).toBeUndefined();
        expect(
          resolveReplyCronChannelRequester(context, { ...params, senderId: "other" }),
        ).toBeUndefined();
        expect(
          resolveReplyCronChannelRequester(context, { ...params, channel: "other" }),
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

it.each(["telegram", "discord", "slack"])("rejects an unbound %s owner", (channel) => {
  expect(
    resolveReplyCronChannelRequester({}, { channel, senderId: "123", accountId: "work" }),
  ).toBeUndefined();
});
