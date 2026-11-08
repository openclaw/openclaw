/* @vitest-environment jsdom */

import type { ConversationListItem } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { cronListResponse, operatorHello, waitForCronPage } from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

const telegramTarget = "-1001234567890";
const webhookTarget = "https://example.test/hooks/saved";
const accountUrl = "https://example.test/account-name";
const telegramAccounts = ["default", "work", "ops"];

const conversation = (
  accountId: string,
  target: string,
  threadId?: string,
): ConversationListItem => ({
  conversationRef: `conv_${accountId}${threadId ?? target}`,
  channel: "telegram",
  accountId,
  kind: "group",
  target,
  firstSeenAt: 0,
  lastSeenAt: 0,
  ...(threadId ? { threadId } : {}),
});

function suggestions(page: Element, id: string): string[] {
  return Array.from(
    page.querySelectorAll<HTMLOptionElement>(`#${id} option`),
    (option) => option.value,
  );
}

async function mountSuggestions(conversations: ConversationListItem[]) {
  const mounted = mountCronPage(
    cronRpc({
      "cron.list": () =>
        cronListResponse([
          createCronViewJob("telegram-job", {
            schedule: { kind: "cron", expr: "0 9 * * *", tz: "Etc/GMT+12" },
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Daily summary" },
            delivery: {
              mode: "announce",
              channel: "telegram",
              to: telegramTarget,
              accountId: "default",
            },
          }),
          createCronViewJob("webhook-job", {
            sessionTarget: "isolated",
            payload: { kind: "agentTurn", message: "Daily summary" },
            delivery: { mode: "webhook", to: webhookTarget },
          }),
        ]),
      "conversations.list": () => ({ conversations }),
    }),
    { render: true, scopeId: "writer" },
  );
  mounted.context.acquireChannels(createChannelCapability).state.channelsSnapshot = {
    ts: 0,
    channelOrder: ["telegram", "discord"],
    channelLabels: { telegram: "Telegram", discord: "Discord" },
    channels: {},
    channelAccounts: {
      telegram: [
        { accountId: "default", name: telegramTarget },
        { accountId: "work", name: accountUrl },
        // A real ID must survive even when another account uses it as a name.
        { accountId: "ops", name: "work" },
      ],
      discord: [{ accountId: "discord-account", name: "Discord account" }],
    },
    channelDefaultAccountId: { telegram: "default", discord: "discord-account" },
  };
  mounted.gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
  await waitForCronPage(() => expect(mounted.page.cron.cronJobs).toHaveLength(2));
  expect(mounted.page.querySelector("datalist")).toBeNull();
  mounted.page.querySelector<HTMLButtonElement>('[data-test-id="cron-new-task"]')!.click();
  await mounted.page.settle();
  mounted.page.patchForm({
    deliveryMode: "announce",
    deliveryChannel: "telegram",
    deliveryAccountId: "default",
  });
  await waitForCronPage(() =>
    expect(mounted.page.deliveryDirectory.conversations).toHaveLength(conversations.length),
  );
  return mounted.page;
}

it.each([
  ["telegram", "announce", [telegramTarget, webhookTarget], telegramAccounts],
  ["last", "announce", [telegramTarget, webhookTarget], [...telegramAccounts, "discord-account"]],
  ["telegram", "webhook", [webhookTarget], telegramAccounts],
  ["unconfigured", "announce", [telegramTarget, webhookTarget], []],
] as const)(
  "suggests account IDs and separate %s %s recipients",
  async (channel, mode, recipients, accounts) => {
    const page = await mountSuggestions([
      conversation("default", "-1009876543210"),
      conversation("default", "https://example.test/conversation-shaped-url"),
    ]);
    // Inspect each projection of the accepted directory without requesting a replacement.
    page.cron.cronForm.deliveryChannel = channel;
    page.cron.cronForm.deliveryMode = mode;
    page.refreshView();
    await waitForCronPage(() => {
      expect(suggestions(page, "cron-delivery-to-suggestions")).toEqual(
        mode === "webhook"
          ? recipients
          : [
              ...recipients,
              "-1009876543210",
              "https://example.test/conversation-shaped-url",
            ].toSorted(),
      );
      expect(suggestions(page, "cron-delivery-account-suggestions")).toEqual(accounts);
    });
    expect(suggestions(page, "cron-tz-suggestions")).toContain("Etc/GMT+12");
  },
);

it("requires an explicit account before exposing routeable target suggestions", async () => {
  const page = await mountSuggestions([
    conversation("personal", "-100personal"),
    conversation("work", "-100work"),
    conversation("work", "-100work", "42"),
  ]);
  page.patchForm({ deliveryAccountId: " work " });
  await waitForCronPage(() =>
    expect(suggestions(page, "cron-delivery-to-suggestions")).toEqual([
      telegramTarget,
      "-100work",
      webhookTarget,
    ]),
  );
  page.patchForm({ deliveryAccountId: "" });
  await waitForCronPage(() =>
    expect(suggestions(page, "cron-delivery-to-suggestions")).toEqual([
      telegramTarget,
      webhookTarget,
    ]),
  );
});
