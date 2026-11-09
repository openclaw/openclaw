import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { createApplicationRouter } from "../../app-routes.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { callsFor, expectCalls, testId, attribute } from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
} from "./cron-page.test-support.tsx";
import { cronRpc, emitEvent, mountCronPage } from "./cron-rpc.test-support.ts";
import {
  createCronViewJob,
  createCronViewRun,
  cronRunsResponse,
  getButtonByText,
} from "./view.test-support.ts";

type Page = ReturnType<typeof mountCronPage>["page"];
const row = (page: Page, id: string) => page.querySelector<HTMLElement>(testId(`cron-row-${id}`));
const rowToggle = (page: Page, id: string) =>
  page.querySelector<HTMLInputElement>(`${testId(`cron-row-toggle-${id}`)} input`);

it("loads the empty automation suggestions when its Solid route host is attached", async () => {
  const context = createContext(createGateway(createTestGatewayClient(createRequest()), true));
  const router = createApplicationRouter();
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => <RouterOutlet router={router} retryContext={context} />, {
    wrapper: provider.wrapper,
  });
  try {
    await router.navigate("cron", context);
    await waitForSolid(() => {
      expect(mounted.container.querySelectorAll(".cron-suggestion").length).toBeGreaterThan(0);
    });
  } finally {
    mounted.unmount();
    router.stop();
  }
});

it("reveals admitted jobs without waiting for scheduler status or duplicating reads", async () => {
  const job = createCronViewJob("coordinated");
  const status = createDeferred<{ enabled: boolean; jobs: number; triggersEnabled: boolean }>();
  const list = createDeferred<ReturnType<typeof cronListResponse>>();
  const request = cronRpc({
    "cron.status": () => status.promise,
    "cron.list": () => list.promise,
  });
  const { page } = mountCronPage(request);
  try {
    await waitForSolid(() => {
      expect(page.querySelector('[data-test-id="cron-jobs-loading"]')).not.toBeNull();
      expect(page.querySelector(".cron-table")?.getAttribute("aria-busy")).toBe("true");
    });
    list.resolve(cronListResponse([job]));
    await waitForSolid(() =>
      expect(page.querySelector('[data-test-id="cron-row-coordinated"]')).not.toBeNull(),
    );
    status.resolve({ enabled: false, jobs: 1, triggersEnabled: true });
    await waitForSolid(() => {
      expect(row(page, "coordinated")).not.toBeNull();
      expect(page.querySelector('[data-test-id="cron-scheduler-banner"]')).not.toBeNull();
    });
    expectCalls(request, ["cron.list", "cron.status"], 1);
    expectCalls(request, ["cron.runs"], 0);
  } finally {
    status.resolve({ enabled: true, jobs: 1, triggersEnabled: true });
    list.resolve(cronListResponse([job]));
    page.remove();
  }
});

it("loads history and delivery accounts only for their visible automation surfaces", async () => {
  const job = createCronViewJob("visible-reads", {
    state: {},
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Review the garden" },
    delivery: { mode: "announce", channel: "telegram", accountId: "garden" },
  });
  const result = cronRunsResponse([
    createCronViewRun({ jobId: job.id, summary: "Garden review complete" }),
  ]);
  const held = createDeferred<typeof result>();
  let holding = false;
  const request = cronRpc({
    "cron.list": () => cronListResponse([job]),
    "cron.runs": () => (holding ? held.promise : result),
    "conversations.list": () => ({ conversations: [] }),
    "channels.status": () => ({
      ts: 0,
      channelOrder: ["telegram"],
      channels: {},
      channelAccounts: { telegram: [{ accountId: "garden" }] },
    }),
  });
  const gateway = createGateway(createTestGatewayClient(request), true);
  const channels = createChannelCapability(gateway);
  const context = createContext(gateway);
  context.agents.state.agentsList!.agents.push({ id: "garden" });
  const page = createPage({ ...context, acquireChannels: () => channels }, { render: true });
  const clickTab = (id: string) => page.querySelector<HTMLButtonElement>(testId(id))!.click();
  try {
    await waitForSolid(() => expect(row(page, job.id)).not.toBeNull());
    expect(page.querySelector("h1")?.textContent).toBe("Automations");
    expect(page.querySelector(".page-subtitle")?.textContent).toContain(
      "Schedule recurring tasks for your agents.",
    );
    expect(page.querySelector(".page-subtitle a")?.textContent).toContain("Learn more");
    expect(page.querySelector(".hub-page-header__actions .agent-select__trigger")).not.toBeNull();
    const history = getButtonByText(page, "Run history");
    expect(history.getAttribute("role")).not.toBe("tab");
    expect(history.closest('[role="tablist"]')).toBeNull();
    expectCalls(request, ["cron.runs", "channels.status"], 0);
    history.click();
    await waitForSolid(() =>
      expect(page.querySelector(".cron-run-entry")?.textContent).toContain(
        "Garden review complete",
      ),
    );
    expect(page.querySelector("h1")?.textContent).toBe("Run history");
    expect(page.querySelector('[role="region"][aria-label="Run history"]')).not.toBeNull();
    expect(page.querySelector(".page-subtitle")?.textContent).toContain(
      "Every run of your automations.",
    );
    expect(history.getAttribute("aria-pressed")).toBe("true");
    expect(page.querySelector(".cron-list-hub-tabs")).toBeNull();
    expect(page.querySelector(".cron-toolbar:not(.cron-run-toolbar)")).toBeNull();
    expect(page.querySelector(".hub-page-header__actions .agent-select__trigger")).not.toBeNull();
    expectCalls(request, ["cron.runs"], 1);

    holding = true;
    emitEvent(gateway, "cron", {}, 2);
    await page.settle();
    expectCalls(request, ["cron.runs"], 2);
    emitEvent(gateway);
    await page.settle();
    history.click();
    await page.settle();
    expect(page.querySelector("h1")?.textContent).toBe("Automations");
    held.resolve(result);
    await held.promise;
    await page.settle();
    expectCalls(request, ["cron.runs"], 2);
    holding = false;
    request.mockClear();
    emitEvent(gateway);
    await page.settle();
    expectCalls(request, ["cron.runs", "channels.status"], 0);

    row(page, job.id)!.click();
    await waitForSolid(() =>
      expect(
        page.querySelector('#cron-delivery-account-suggestions option[value="garden"]'),
      ).not.toBeNull(),
    );
    expectCalls(request, ["channels.status"], 1);
    expectCalls(request, ["cron.runs"], 0);
    clickTab("cron-detail-tab-history");
    await waitForSolid(() =>
      expect(page.querySelector(".cron-run-entry")?.textContent).toContain(
        "Garden review complete",
      ),
    );
    expectCalls(request, ["cron.runs"], 1);
    expect(request).toHaveBeenCalledWith(
      "cron.runs",
      expect.objectContaining({ scope: "job", id: job.id }),
    );
    clickTab("cron-detail-tab-settings");
    await waitForSolid(() => expectCalls(request, ["channels.status"], 2));
    expectCalls(request, ["cron.runs"], 1);
  } finally {
    held.resolve(result);
    page.remove();
    channels.dispose();
  }
});

it.each([true, false])(
  "reconciles an optimistic pause with its owner (accepted: %s)",
  async (accepted) => {
    const job = createCronViewJob("optimistic", { enabled: true });
    const update = createDeferred<CronJob>();
    let serverJob = job;
    const otherJob = createCronViewJob("other");
    const refreshed = createDeferred<ReturnType<typeof cronListResponse>>();
    let reconciling = false;
    const request = cronRpc({
      "cron.list": () =>
        reconciling ? refreshed.promise : cronListResponse([{ ...serverJob }, otherJob]),
      "cron.update": () => update.promise,
    });
    const { page } = mountCronPage(request);
    const selector = '[data-test-id="cron-row-toggle-optimistic"] input';
    try {
      await waitForSolid(() => expect(page.querySelector(selector)).not.toBeNull());
      const readsBeforePause = callsFor(request, "cron.list").length;
      const originalRow = page.querySelector('[data-test-id="cron-row-optimistic"]');
      const toggle = page.querySelector<HTMLInputElement>(selector)!;
      const disabledChanges: MutationRecord[] = [];
      const observer = new MutationObserver((records) => disabledChanges.push(...records));
      observer.observe(toggle, { attributes: true, attributeFilter: ["disabled"] });
      onTestFinished(() => observer.disconnect());
      toggle.focus();
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForSolid(() => {
        expect(request).toHaveBeenCalledWith("cron.update", {
          id: job.id,
          expectedConfigRevision: "config-revision-optimistic",
          patch: { enabled: false },
        });
        expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(false);
        expect(attribute(page, selector, "aria-disabled")).toBe("true");
      });
      expect(toggle.disabled).toBe(false);
      expect(
        page.querySelector<HTMLButtonElement>(testId("cron-row-run-optimistic"))?.disabled,
      ).toBe(true);
      expect(document.activeElement).toBe(toggle);
      expect(rowToggle(page, "other")?.disabled).toBe(true);
      toggle.click();
      expectCalls(request, ["cron.update"], 1);
      // The visual expected value never becomes synchronous domain authority.
      expect(page.cron.cronJobs[0]?.enabled).toBe(true);
      if (accepted) {
        serverJob = { ...job, enabled: false, updatedAtMs: 2, configRevision: "paused" };
        reconciling = true;
        update.resolve(serverJob);
        await waitForSolid(() => expectCalls(request, ["cron.list"], readsBeforePause + 1));
        expect(toggle.disabled).toBe(false);
        expect(toggle.getAttribute("aria-disabled")).toBe("true");
        expect(document.activeElement).toBe(toggle);
        refreshed.resolve(cronListResponse([serverJob, otherJob]));
      } else {
        update.reject(new Error("Gateway declined the pause"));
      }
      await waitForSolid(() => {
        expect(attribute(page, selector, "aria-disabled")).toBeNull();
        expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(!accepted);
      });
      expect(page.querySelector('[data-test-id="cron-row-optimistic"]')).toBe(originalRow);
      expect(document.activeElement).toBe(toggle);
      expect(toggle.disabled).toBe(false);
      disabledChanges.push(...observer.takeRecords());
      observer.disconnect();
      expect(disabledChanges).toHaveLength(0);
      if (!accepted) {
        expect(page.textContent).toContain("Gateway declined the pause");
      }
      expectCalls(request, ["cron.list"], readsBeforePause + (accepted ? 1 : 0));
    } finally {
      update.resolve(job);
      refreshed.resolve(cronListResponse([serverJob, otherJob]));
      page.remove();
    }
  },
);

it("retries an initial list failure through the owner from the error boundary", async () => {
  const warn = vi.spyOn(console, "warn");
  const job = createCronViewJob("retried");
  let failed = true;
  const request = cronRpc({
    "cron.list": () => {
      if (failed) {
        throw new Error("List unavailable");
      }
      return cronListResponse([job]);
    },
  });
  const { page } = mountCronPage(request);
  try {
    await waitForSolid(() => expect(page.textContent).toContain("List unavailable"));
    await waitForSolid(() => expect(getButtonByText(page, "Retry")).toBeDefined());
    const readsBeforeRetry = callsFor(request, "cron.list").length;
    failed = false;
    getButtonByText(page, "Retry").click();
    await waitForSolid(() => expect(row(page, "retried")).not.toBeNull());
    expectCalls(request, ["cron.list"], readsBeforeRetry + 1);
    expect(page.textContent).not.toContain("List unavailable");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("ASYNC_OUTSIDE_LOADING_BOUNDARY");
  } finally {
    warn.mockRestore();
    page.remove();
  }
});

it.each(["replacement", "reconnect"] as const)(
  "retires a pending optimistic pause on Gateway %s",
  async (transition) => {
    const initialJob = createCronViewJob("shared-id", { name: "Original Gateway", enabled: true });
    const replacementJob = { ...initialJob, name: "Current Gateway", enabled: true };
    const paused = createDeferred<CronJob>();
    let current = false;
    const request = cronRpc({
      "cron.list": () => cronListResponse([{ ...(current ? replacementJob : initialJob) }]),
      "cron.update": () => paused.promise,
    });
    const { page, gateway } = mountCronPage(request);
    const selector = '[data-test-id="cron-row-toggle-shared-id"] input';
    try {
      await waitForSolid(() => expect(page.querySelector(selector)).not.toBeNull());
      const toggle = page.querySelector<HTMLInputElement>(selector)!;
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
      await waitForSolid(() => {
        expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(true);
        expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(false);
        expect(attribute(page, selector, "aria-disabled")).toBe("true");
      });
      current = true;
      if (transition === "replacement") {
        const nextRequest = cronRpc({
          "cron.list": () => cronListResponse([{ ...replacementJob }]),
        });
        gateway.emitSnapshot({ client: createTestGatewayClient(nextRequest), phase: "connected" });
      } else {
        gateway.emitSnapshot({ phase: "reconnecting" });
        gateway.emitSnapshot({ phase: "connected" });
      }
      await waitForSolid(() => {
        expect(page.cron.cronJobs[0]?.name).toBe("Current Gateway");
        expect(page.textContent).toContain("Current Gateway");
        expect(page.cron.cronJobs[0]?.enabled).toBe(true);
        expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(true);
        expect(attribute(page, selector, "aria-disabled")).toBeNull();
      });
      paused.resolve({ ...initialJob, enabled: false });
      await page.settle();
      expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(true);
      expect(attribute(page, selector, "aria-disabled")).toBeNull();
    } finally {
      paused.resolve({ ...initialJob, enabled: false });
      page.remove();
    }
  },
);

it("retires a pending refresh on Gateway replacement", async () => {
  const original = createCronViewJob("refresh-owner", { name: "Original Gateway" });
  const replacement = { ...original, name: "Current Gateway" };
  const status = createDeferred<unknown>();
  const fallback = createRequest();
  let hold = false;
  const request = cronRpc({
    "cron.list": () => cronListResponse([original]),
    "cron.status": () => (hold ? status.promise : fallback("cron.status")),
  });
  const { page, gateway } = mountCronPage(request);
  try {
    await waitForSolid(() =>
      expect(page.querySelector<HTMLButtonElement>(".cron-refresh")?.disabled).toBe(false),
    );
    const reads = callsFor(request, "cron.status").length;
    hold = true;
    page.querySelector<HTMLButtonElement>(".cron-refresh")!.click();
    await waitForSolid(() =>
      expect(callsFor(request, "cron.status").length).toBeGreaterThan(reads),
    );
    const next = cronRpc({ "cron.list": () => cronListResponse([replacement]) });
    gateway.emitSnapshot({ client: createTestGatewayClient(next), phase: "connected" });
    await waitForSolid(() => {
      expect(row(page, "refresh-owner")).not.toBeNull();
      expect(row(page, "refresh-owner")!.textContent).toContain("Current Gateway");
      expect(page.querySelector<HTMLButtonElement>(".cron-refresh")?.disabled).toBe(false);
    });
    status.resolve(fallback("cron.status"));
    await page.settle();
    expect(row(page, "refresh-owner")).not.toBeNull();
    expect(row(page, "refresh-owner")!.textContent).toContain("Current Gateway");
  } finally {
    status.resolve(fallback("cron.status"));
    page.remove();
  }
});
