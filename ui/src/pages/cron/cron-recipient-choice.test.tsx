import { expect, it } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { callsFor, waitForElement, fillInput } from "./cron-assertions.test-support.ts";
import { cronListResponse } from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

it("selects a named topic only within the chosen account and saves its exact route", async () => {
  const initial = createCronViewJob("recipient", {
    agentId: "main",
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Keep prompt" },
    delivery: {
      mode: "announce",
      channel: "telegram",
      accountId: "work",
      to: "-100old",
      threadId: "7",
    },
    failureAlert: { channel: "telegram", accountId: "personal", to: "-100personal" },
  });
  const saved = {
    ...initial,
    configRevision: "recipient-v2",
    delivery: { ...initial.delivery!, to: "-100team", threadId: "42" },
  };
  let job = initial;
  const conversations = [
    {
      conversationRef: "conv_11111111111111111111111111111111",
      channel: "telegram",
      accountId: "work",
      kind: "group",
      target: "-100team",
      threadId: "42",
      label: "Release team",
      firstSeenAt: 0,
      lastSeenAt: 1,
    },
    {
      conversationRef: "conv_22222222222222222222222222222222",
      channel: "telegram",
      accountId: "work",
      kind: "group",
      target: "-100team",
      threadId: "99",
      label: "Release team",
      firstSeenAt: 0,
      lastSeenAt: 1,
    },
    {
      conversationRef: "conv_33333333333333333333333333333333",
      channel: "telegram",
      accountId: "personal",
      kind: "group",
      target: "-100personal",
      label: "Private group",
      firstSeenAt: 0,
      lastSeenAt: 1,
    },
  ];
  const request = cronRpc({
    "cron.list": () => cronListResponse([job]),
    "conversations.list": () => ({ conversations }),
    "cron.update": () => {
      job = saved;
      return saved;
    },
  });
  const { page } = mountCronPage(request);
  try {
    (await waitForElement(page, '[data-test-id="cron-row-recipient"]')).click();
    (await waitForElement<HTMLButtonElement>(page, "button#cron-delivery-to")).click();
    await waitForSolid(() =>
      expect(
        document.querySelector(
          '[role="option"][data-value="conv_11111111111111111111111111111111"]',
        ),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[role="option"][data-value="conv_33333333333333333333333333333333"]'),
    ).toBeNull();
    expect(
      document.querySelector('[role="option"][data-value="conv_11111111111111111111111111111111"]')
        ?.textContent,
    ).toContain("Release team");
    expect(
      document.querySelector('[role="option"][data-value="conv_22222222222222222222222222222222"]')
        ?.textContent,
    ).toContain("99");
    document
      .querySelector<HTMLElement>(
        '[role="option"][data-value="conv_11111111111111111111111111111111"]',
      )!
      .click();
    expect(page.cron.cronForm).toMatchObject({
      deliveryTo: "-100team",
      deliveryThreadId: "42",
      deliveryAccountId: "work",
      failureAlertTo: "-100personal",
      failureAlertAccountId: "personal",
    });
    expect(callsFor(request, "cron.update")).toHaveLength(0);
    (await waitForElement(page, '[data-test-id="cron-submit"]')).click();
    await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(1));
    expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
      patch: {
        delivery: { channel: "telegram", accountId: "work", to: "-100team", threadId: "42" },
        failureAlert: { accountId: "personal", to: "-100personal" },
      },
    });
    await waitForSolid(() => {
      expect(page.cron.cronBusy).toBe(false);
      expect(page.cron.cronError).toBeNull();
      expect(page.querySelector("#cron-delivery-to")?.textContent).toContain("Release team");
    });
    (await waitForElement<HTMLButtonElement>(page, "button#cron-delivery-to")).click();
    await waitForSolid(() =>
      expect(document.querySelector('[role="option"][data-value=""]')).not.toBeNull(),
    );
    document.querySelector<HTMLElement>('[role="option"][data-value=""]')!.click();
    expect(page.cron.cronForm).toMatchObject({
      deliveryTo: "",
      deliveryThreadId: undefined,
      deliveryAccountId: "work",
    });
  } finally {
    page.remove();
  }
});

it("keeps unresolved recipients editable and preserves custom drafts after save rejection", async () => {
  const job = createCronViewJob("custom-recipient", {
    agentId: "main",
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Keep prompt" },
    delivery: {
      mode: "announce",
      channel: "telegram",
      accountId: "work",
      to: "-100saved",
      threadId: "7",
    },
  });
  const request = cronRpc({
    "cron.list": () => cronListResponse([job]),
    "conversations.list": () => {
      throw new Error("Synthetic directory failure");
    },
    "cron.update": () => {
      throw new Error("Synthetic save failure");
    },
  });
  const { page } = mountCronPage(request);
  try {
    (await waitForElement(page, '[data-test-id="cron-row-custom-recipient"]')).click();
    const trigger = await waitForElement<HTMLButtonElement>(page, "button#cron-delivery-to");
    await waitForSolid(() => expect(trigger.textContent).toContain("-100saved"));
    trigger.click();
    let option: HTMLElement | undefined;
    await waitForSolid(() => {
      option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (node) => node.textContent?.trim() === "Enter another recipient…",
      );
      expect(option).toBeDefined();
    });
    option!.click();
    const input = await waitForElement<HTMLInputElement>(
      page,
      'input[aria-label="Custom recipient"]',
    );
    fillInput(page, 'input[aria-label="Custom recipient"]', "-100unlisted");
    fillInput(page, "#cron-name", "Keep edited name");
    (await waitForElement(page, '[data-test-id="cron-submit"]')).click();
    await waitForSolid(() => expect(page.textContent).toContain("Synthetic save failure"));
    expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
      patch: {
        name: "Keep edited name",
        delivery: { to: "-100unlisted", threadId: null, accountId: "work" },
      },
    });
    expect(page.querySelector('input[aria-label="Custom recipient"]')).toBe(input);
    expect(input.value).toBe("-100unlisted");
  } finally {
    page.remove();
  }
});
