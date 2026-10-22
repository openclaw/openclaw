import type { ConversationListItem } from "@openclaw/gateway-protocol";
import { expect, it, onTestFinished } from "vitest";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { buildCronSuggestions, resolveConversationTargetSuggestions } from "./form-suggestions.ts";
import { createCronViewJob } from "./view.test-support.ts";

const telegramTarget = "-1001234567890";
const webhookTarget = "https://example.test/hooks/saved";
const accountUrl = "https://example.test/account-name";
const telegramAccounts = ["default", "work", "ops"];

it.each([
  ["telegram", "announce", [telegramTarget, webhookTarget], telegramAccounts],
  ["last", "announce", [telegramTarget, webhookTarget], [...telegramAccounts, "discord-account"]],
  ["telegram", "webhook", [webhookTarget], telegramAccounts],
  ["unconfigured", "announce", [telegramTarget, webhookTarget], []],
] as const)(
  "suggests account IDs and separate %s %s recipients",
  (channel, mode, recipients, accounts) => {
    const channels = createChannelCapability({
      snapshot: { client: null, phase: "stopped" },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });
    onTestFinished(() => channels.dispose());
    channels.state.channelsSnapshot = {
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
    const cron = createInitialCronState();
    cron.cronForm.deliveryChannel = channel;
    cron.cronForm.deliveryMode = mode;
    cron.cronJobs = [
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
    ];

    const suggestions = buildCronSuggestions({
      channels: channels.state,
      runtimeConfig: createInitialConfigState(),
      cron,
      agentsList: null,
      modelSuggestions: [],
      conversationTargets: ["-1009876543210", "https://example.test/conversation-shaped-url"],
    });

    expect(suggestions.deliveryToSuggestions).toEqual(
      mode === "webhook"
        ? recipients
        : [
            ...recipients,
            "-1009876543210",
            "https://example.test/conversation-shaped-url",
          ].toSorted(),
    );
    expect(suggestions.accountTargets).toEqual(accounts);
    expect(suggestions.timezoneSuggestions).toContain("Etc/GMT+12");
  },
);
const conversation = (accountId: string, threadId?: string): ConversationListItem => ({
  conversationRef: `conv_${accountId}${threadId ?? ""}`,
  channel: "telegram",
  accountId,
  kind: "group",
  target: `-100${accountId}`,
  firstSeenAt: 0,
  lastSeenAt: 0,
  ...(threadId ? { threadId } : {}),
});
const conversations = [conversation("personal"), conversation("work"), conversation("work", "42")];

it("requires an explicit account before exposing routeable target suggestions", () => {
  expect(resolveConversationTargetSuggestions(conversations, " work ")).toEqual(["-100work"]);
  expect(resolveConversationTargetSuggestions(conversations, "")).toEqual([]);
});
