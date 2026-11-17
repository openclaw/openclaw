import { expect, it } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { callsFor, fillInput, waitForElement } from "./cron-assertions.test-support.ts";
import { cronListResponse } from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

it("chooses independent schedule and active-hours zones, saves, reopens, and restores defaults", async () => {
  let job = createCronViewJob("zones", {
    configRevision: "zones-v1",
    activeHours: { start: "09:00", end: "17:00", timezone: "user" },
  });
  let savedJob = job;
  const request = cronRpc({
    "cron.list": () => cronListResponse([job]),
    "cron.update": () => {
      job = savedJob;
      return job;
    },
  });
  let { page } = mountCronPage(request);
  const choose = async (field: string, label: string) => {
    (await waitForElement<HTMLButtonElement>(page, "button#cron-" + field)).click();
    let option: HTMLElement | undefined;
    await waitForSolid(() => {
      option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (node) => node.textContent?.trim() === label,
      );
      expect(option).toBeDefined();
    });
    option!.click();
  };
  try {
    (await waitForElement(page, '[data-test-id="cron-row-zones"]')).click();
    await choose("cron-tz", "America/New York");
    (await waitForElement(page, "details.cron-advanced > summary")).click();
    await choose("active-hours-timezone", "Gateway time zone");
    expect(callsFor(request, "cron.update")).toHaveLength(0);
    savedJob = {
      ...job,
      configRevision: "zones-v2",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
      activeHours: { start: "09:00", end: "17:00", timezone: "local" },
    };
    (await waitForElement(page, '[data-test-id="cron-submit"]')).click();
    await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(1));
    expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
      patch: {
        schedule: { kind: "cron", tz: "America/New_York" },
        activeHours: { start: "09:00", end: "17:00", timezone: "local" },
      },
    });

    await waitForSolid(() => {
      expect(page.cron.cronBusy).toBe(false);
      expect(page.cron.cronError).toBeNull();
    });
    page.remove();
    page = mountCronPage(request).page;
    (await waitForElement(page, '[data-test-id="cron-row-zones"]')).click();
    await waitForSolid(() =>
      expect(page.querySelector("#cron-cron-tz")?.textContent).toContain("America/New York"),
    );
    await choose("cron-tz", "Gateway time zone (default)");
    (await waitForElement(page, "details.cron-advanced > summary")).click();
    await choose("active-hours-timezone", "User time zone (default)");
    savedJob = {
      ...job,
      configRevision: "zones-v3",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      activeHours: { start: "09:00", end: "17:00" },
    };
    (await waitForElement(page, '[data-test-id="cron-submit"]')).click();
    await waitForSolid(() => expect(callsFor(request, "cron.update")).toHaveLength(2));
    expect(callsFor(request, "cron.update")[1]?.[1]).toMatchObject({
      patch: {
        schedule: { kind: "cron", expr: "0 9 * * *" },
        activeHours: { start: "09:00", end: "17:00" },
      },
    });
    const second = callsFor(request, "cron.update")[1]?.[1];
    expect(JSON.stringify(second)).not.toContain('"tz":');
    expect(JSON.stringify(second)).not.toContain('"timezone":');
  } finally {
    page.remove();
  }
});

it("keeps saved aliases and custom values through rejection without writing on picker dismissal", async () => {
  const job = createCronViewJob("aliases", {
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "US/Pacific" },
  });
  const request = cronRpc({
    "cron.list": () => cronListResponse([job]),
    "cron.update": () => {
      throw new Error("Synthetic write failure");
    },
  });
  const { page } = mountCronPage(request);
  try {
    (await waitForElement(page, '[data-test-id="cron-row-aliases"]')).click();
    const trigger = await waitForElement<HTMLButtonElement>(page, "button#cron-cron-tz");
    expect(trigger.textContent).toContain("US/Pacific");
    trigger.click();
    await waitForSolid(() => expect(document.querySelector('[role="option"]')).not.toBeNull());
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(callsFor(request, "cron.update")).toHaveLength(0);
    trigger.click();
    let custom: HTMLElement | undefined;
    await waitForSolid(() => {
      custom = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((node) =>
        node.textContent?.includes("Enter another time zone"),
      );
      expect(custom).toBeDefined();
    });
    custom!.click();
    const input = await waitForElement<HTMLInputElement>(page, '[aria-label="Custom time zone"]');
    await waitForSolid(() => expect(document.activeElement).toBe(input));
    fillInput(page, '[aria-label="Custom time zone"]', "EST");
    fillInput(page, "#cron-name", "Keep changed name");
    (await waitForElement(page, '[data-test-id="cron-submit"]')).click();
    await waitForSolid(() => expect(page.textContent).toContain("Synthetic write failure"));
    expect(callsFor(request, "cron.update")[0]?.[1]).toMatchObject({
      patch: { name: "Keep changed name", schedule: { tz: "EST" } },
    });
    expect(input.value).toBe("EST");
    fillInput(page, '[aria-label="Custom time zone"]', "Not/AZone");
    await waitForSolid(() =>
      expect(page.querySelector<HTMLButtonElement>('[data-test-id="cron-submit"]')?.disabled).toBe(
        true,
      ),
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(callsFor(request, "cron.update")).toHaveLength(1);
  } finally {
    page.remove();
  }
});
