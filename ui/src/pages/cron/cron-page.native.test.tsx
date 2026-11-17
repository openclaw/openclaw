import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationRouter } from "../../app-routes.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createChannelCapability } from "../../lib/channels/index.ts";
import {
  DEFAULT_AUTOMATIONS_FILTER,
  setAutomationsFilter,
} from "../../lib/cron/automations-filter.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { callsFor, expectCalls, testId } from "./cron-assertions.test-support.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  heldJob,
  openJob,
} from "./cron-page.test-support.tsx";
import { cronRpc, emitEvent, mountCronPage } from "./cron-rpc.test-support.ts";
import {
  createCronViewJob,
  createCronViewRun,
  cronRunsResponse,
  getButtonByText,
} from "./view.test-support.ts";

it("renders the empty Automations page when its Solid route host is attached", async () => {
  const context = createContext(createGateway(createTestGatewayClient(createRequest()), true));
  const router = createApplicationRouter();
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => <RouterOutlet router={router} retryContext={context} />, {
    wrapper: provider.wrapper,
  });
  try {
    await router.navigate("cron", context);
    await waitForSolid(() => {
      expect(mounted.container.querySelector(testId("cron-new-task"))).not.toBeNull();
    });
  } finally {
    mounted.unmount();
    router.stop();
  }
});

it("admits jobs without waiting for scheduler status or duplicating reads", async () => {
  const job = createCronViewJob("coordinated");
  const status = createDeferred<{ enabled: boolean; jobs: number; triggersEnabled: boolean }>();
  const list = createDeferred<ReturnType<typeof cronListResponse>>();
  const request = cronRpc({
    "cron.status": () => status.promise,
    "cron.list": () => list.promise,
  });
  const { page } = mountCronPage(request);
  try {
    await waitForSolid(() => expect(page.cron.cronLoading).toBe(true));
    list.resolve(cronListResponse([job]));
    await waitForSolid(() => expect(page.cron.cronJobs.map(({ id }) => id)).toEqual([job.id]));
    status.resolve({ enabled: false, jobs: 1, triggersEnabled: true });
    await waitForSolid(() =>
      expect(page.querySelector('[data-test-id="cron-scheduler-banner"]')).not.toBeNull(),
    );
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
  const page = createPage(
    { ...createContext(gateway), acquireChannels: () => channels },
    { render: true },
  );
  const clickButton = (id: string) => page.querySelector<HTMLButtonElement>(testId(id))!.click();
  try {
    await heldJob(page, job.id);
    expectCalls(request, ["cron.runs", "channels.status"], 0);
    page.routeSearch = "?activity";
    await waitForSolid(() =>
      expect(page.querySelector(".cron-run-entry")?.textContent).toContain(
        "Garden review complete",
      ),
    );
    expectCalls(request, ["cron.runs"], 1);

    holding = true;
    emitEvent(gateway, "cron", {}, 2);
    await page.settle();
    expectCalls(request, ["cron.runs"], 2);
    emitEvent(gateway);
    await page.settle();
    page.routeSearch = "";
    await page.settle();
    held.resolve(result);
    await held.promise;
    await page.settle();
    expectCalls(request, ["cron.runs"], 2);
    holding = false;
    request.mockClear();
    emitEvent(gateway);
    await page.settle();
    expectCalls(request, ["cron.runs", "channels.status"], 0);

    await openJob(page, job.id);
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
    expectCalls(request, ["channels.status"], 0);
    clickButton("cron-edit");
    await waitForSolid(() =>
      expect(
        page.querySelector('#cron-delivery-account-suggestions option[value="garden"]'),
      ).not.toBeNull(),
    );
    expectCalls(request, ["channels.status"], 1);
    expectCalls(request, ["cron.runs"], 1);
  } finally {
    held.resolve(result);
    page.remove();
    channels.dispose();
  }
});

it("retries an initial list failure through the owner", async () => {
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
    await waitForSolid(() => expect(page.cron.cronJobs.map(({ id }) => id)).toEqual([job.id]));
    expectCalls(request, ["cron.list"], readsBeforeRetry + 1);
    expect(page.textContent).not.toContain("List unavailable");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("ASYNC_OUTSIDE_LOADING_BOUNDARY");
  } finally {
    warn.mockRestore();
    page.remove();
  }
});

it("offers the shared automation filters in the native embedded list", async () => {
  vi.stubGlobal("__OPENCLAW_NATIVE_EMBED__", { platform: "ios", formFactor: "pad" });
  const active = createCronViewJob("active", { name: "Active task" });
  const paused = createCronViewJob("paused", { name: "Paused task", enabled: false });
  const request = cronRpc({ "cron.list": () => cronListResponse([active, paused]) });
  const gateway = createGateway(createTestGatewayClient(request), true);
  gateway.emitSnapshot({ hello: gatewayHelloForMethods(["cron.list"]) });
  const page = createPage(createContext(gateway), { render: true });
  try {
    await waitForSolid(() =>
      expect(page.querySelector('.sidebar-automations a[href*="?job=active"]')).not.toBeNull(),
    );
    const filter = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "Filters",
    );
    expect(filter).toBeDefined();
    filter!.click();
    await waitForSolid(() =>
      expect(document.querySelector("#sidebar-automations-status")).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>("#sidebar-automations-status")!.click();
    await waitForSolid(() =>
      expect(document.querySelector('[role="option"][data-value="paused"]')).not.toBeNull(),
    );
    document.querySelector<HTMLElement>('[role="option"][data-value="paused"]')!.click();
    await waitForSolid(() => {
      expect(page.querySelector('.sidebar-automations a[href*="?job=active"]')).toBeNull();
      expect(page.querySelector('.sidebar-automations a[href*="?job=paused"]')).not.toBeNull();
      expect(document.activeElement).toBe(filter);
    });
    filter!.click();
    await waitForSolid(() => expect(getButtonByText(document.body, "Reset")).toBeDefined());
    getButtonByText(document.body, "Reset").click();
    await waitForSolid(() => {
      expect(page.querySelector('.sidebar-automations a[href*="?job=active"]')).not.toBeNull();
      expect(document.activeElement).toBe(filter);
    });
  } finally {
    page.remove();
    setAutomationsFilter(DEFAULT_AUTOMATIONS_FILTER);
    vi.unstubAllGlobals();
  }
});
