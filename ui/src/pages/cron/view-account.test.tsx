/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  callsFor,
  click,
  fillInput,
  testId,
  waitForElement,
} from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  cronListResponse,
} from "./cron-page.test-support.tsx";
import { cronRpc } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});
async function fixture(rejectUpdate = false) {
  const job = createCronViewJob("account-job", {
    configRevision: "route-v1",
    agentId: "main",
    name: "Digest",
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Keep this prompt." },
    delivery: {
      mode: "announce",
      channel: "telegram",
      accountId: "ops-42",
      to: "-1001234567890",
      threadId: "42",
    },
    failureAlert: {
      mode: "announce",
      channel: "discord",
      accountId: "alerts-17",
      to: "channel:1234567890",
      threadId: "99",
      after: 1,
    },
  });
  let stored: CronJob = job;
  let updates = 0;
  const request = cronRpc({
    "cron.list": () => cronListResponse([stored]),
    "conversations.list": () => ({ conversations: [] }),
    "cron.update": () => {
      if (rejectUpdate) {
        throw new Error("Example update failure");
      }
      updates += 1;
      stored = {
        ...job,
        configRevision: "route-" + updates,
        delivery: {
          mode: "announce",
          channel: "telegram",
          accountId: updates === 1 ? "backup-9" : undefined,
          to: "-1001234567890",
        },
      };
      return stored;
    },
  });
  const context = createContext(createGateway(createTestGatewayClient(request), true));
  const channels = context.acquireChannels(createChannelCapability);
  channels.state.channelsSnapshot = {
    ts: 0,
    channelOrder: ["telegram", "discord"],
    channelLabels: { telegram: "Telegram", discord: "Discord" },
    channels: {},
    channelAccounts: {
      telegram: [
        { accountId: "ops-42", name: "Operations bot" },
        { accountId: "backup-9", name: "Backup bot" },
      ],
      discord: [{ accountId: "alerts-17", name: "Alert bot" }],
    },
    channelDefaultAccountId: { telegram: "ops-42", discord: "alerts-17" },
  };
  const page = createPage(context, { render: true });
  await waitForElement(page, testId("cron-row-account-job"));
  click(page, testId("cron-row-account-job"));
  await waitForElement(page, "#cron-delivery-account-id");
  return { page, request, channels };
}
async function choose(page: HTMLElement, id: string, value: string) {
  const control = await waitForElement(page, "#" + id);
  control.click();
  const host = control.closest("openclaw-select-picker") ?? control.parentElement!;
  const selector = '[role="option"][data-value="' + value + '"]';
  await waitForSolid(() => expect(host.querySelector(selector)).not.toBeNull());
  host.querySelector<HTMLElement>(selector)!.click();
  flush();
}

it("chooses the named sending account, saves its ID, and clears only that override", async () => {
  const { page, request } = await fixture();
  await choose(page, "cron-delivery-account-id", "backup-9");
  expect(page.cron.cronForm).toMatchObject({
    deliveryAccountId: "backup-9",
    deliveryTo: "-1001234567890",
    deliveryThreadId: undefined,
    failureAlertAccountId: "alerts-17",
    failureAlertThreadId: "99",
    payloadText: "Keep this prompt.",
  });
  expect(callsFor(request, "cron.update")).toHaveLength(0);
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(1));
  expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
    patch: {
      delivery: { accountId: "backup-9", threadId: null },
      payload: { message: "Keep this prompt." },
    },
  });
  await waitForSolid(() => expect(page.cron.cronBusy).toBe(false));
  click(page, testId("cron-back"));
  await waitForElement(page, testId("cron-row-account-job"));
  click(page, testId("cron-row-account-job"));
  await waitForSolid(() =>
    expect(page.querySelector("#cron-delivery-account-id")?.textContent).toContain("Backup bot"),
  );
  await choose(page, "cron-delivery-account-id", "");
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(2));
  expect(callsFor(request, "cron.update")[1]?.[1]).toMatchObject({
    patch: { delivery: { accountId: null } },
  });
});

it("scopes primary and alert choices to their own channels and preserves unknown values", async () => {
  const { page, channels } = await fixture();
  click(page, "#cron-delivery-account-id");
  await waitForElement(page, '[role="option"][data-value="backup-9"]');
  const primary = page
    .querySelector("#cron-delivery-account-id")!
    .closest("openclaw-select-picker")!;
  expect(primary.querySelector('[data-value="alerts-17"]')).toBeNull();
  primary.querySelector<HTMLElement>('[data-value="ops-42"]')!.click();
  flush();
  click(page, "details.cron-advanced > summary");
  click(page, "#cron-failure-alert-account-id");
  await waitForElement(page, '[role="option"][data-value="alerts-17"]');
  const alert = page
    .querySelector("#cron-failure-alert-account-id")!
    .closest("openclaw-select-picker")!;
  expect(alert.querySelector('[data-value="ops-42"]')).toBeNull();
  alert.querySelector<HTMLElement>('[data-value="alerts-17"]')!.click();
  flush();
  await choose(page, "cron-delivery-account-id", "__custom_account__");
  fillInput(page, 'input[aria-label="Custom sending account ID"]', "unlisted-account");
  flush();
  channels.state.channelsSnapshot = null;
  channels.state.channelsError = "Example account discovery failure";
  page.refreshView();
  await page.settle();
  expect(
    page.querySelector<HTMLInputElement>('input[aria-label="Custom sending account ID"]')?.value,
  ).toBe("unlisted-account");
  expect(page.cron.cronForm.failureAlertAccountId).toBe("alerts-17");
  expect(page.textContent).toContain("Example account discovery failure");
});

it("retains an account choice and unrelated draft when saving fails", async () => {
  const { page } = await fixture(true);
  await choose(page, "cron-delivery-account-id", "backup-9");
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(page.textContent).toContain("Example update failure"));
  expect(page.cron.cronForm).toMatchObject({
    deliveryAccountId: "backup-9",
    payloadText: "Keep this prompt.",
  });
  expect(page.querySelector("#cron-delivery-account-id")?.textContent).toContain("Backup bot");
});

it("preserves saved references during unrelated edits when discovery fails", async () => {
  const { page, request, channels } = await fixture();
  channels.state.channelsSnapshot = null;
  channels.state.channelsError = "Example account discovery failure";
  page.refreshView();
  await page.settle();
  expect(page.querySelector("#cron-delivery-account-id")?.textContent).toContain("ops-42");
  page.patchForm({ name: "Renamed digest" });
  await page.settle();
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(1));
  expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
    patch: {
      name: "Renamed digest",
      delivery: { accountId: "ops-42", threadId: "42" },
      failureAlert: { accountId: "alerts-17", threadId: "99" },
    },
  });
});

it("saves the alert account separately and disambiguates duplicate account names", async () => {
  const { page, request, channels } = await fixture();
  const snapshot = channels.state.channelsSnapshot!;
  channels.state.channelsSnapshot = {
    ...snapshot,
    channelAccounts: {
      ...snapshot.channelAccounts,
      discord: [
        ...(snapshot.channelAccounts.discord ?? []),
        { accountId: "other-alerts", name: "Alert bot" },
      ],
    },
  };
  page.refreshView();
  await page.settle();
  click(page, "details.cron-advanced > summary");
  await choose(page, "cron-failure-alert-account-id", "other-alerts");
  expect(page.querySelector("#cron-failure-alert-account-id")?.textContent).toContain(
    "other-alerts",
  );
  expect(page.cron.cronForm).toMatchObject({
    failureAlertAccountId: "other-alerts",
    failureAlertThreadId: undefined,
    deliveryAccountId: "ops-42",
    deliveryThreadId: "42",
  });
  click(page, testId("cron-submit"));
  await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(1));
  expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
    patch: {
      delivery: { accountId: "ops-42", threadId: "42" },
      failureAlert: { accountId: "other-alerts", threadId: null },
    },
  });
});

it("keeps last-channel account references open-ended without guessing a channel", async () => {
  const { page } = await fixture();
  page.patchForm({ deliveryChannel: "last" });
  await page.settle();
  const input = page.querySelector<HTMLInputElement>("input#cron-delivery-account-id");
  expect(input?.value).toBe("ops-42");
  fillInput(page, "#cron-delivery-account-id", "shared-account");
  flush();
  expect(page.cron.cronForm).toMatchObject({
    deliveryChannel: "last",
    deliveryAccountId: "shared-account",
  });
});
