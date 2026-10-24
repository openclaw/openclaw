import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { createApplicationRouter } from "../../app-routes.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForConfirmDialogActions } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createContext,
  createGateway,
  createRequest,
  cronListResponse,
} from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob, getButtonByText, openCronMenu } from "./view.test-support.ts";

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
      expect(page.querySelector('[data-test-id="cron-row-coordinated"]')).not.toBeNull();
      expect(page.querySelector('[data-test-id="cron-scheduler-banner"]')).not.toBeNull();
    });
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(1);
  } finally {
    status.resolve({ enabled: true, jobs: 1, triggersEnabled: true });
    list.resolve(cronListResponse([job]));
    page.remove();
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
      const readsBeforePause = request.mock.calls.filter(
        ([method]) => method === "cron.list",
      ).length;
      const row = page.querySelector('[data-test-id="cron-row-optimistic"]');
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
        expect(page.querySelector<HTMLInputElement>(selector)?.getAttribute("aria-disabled")).toBe(
          "true",
        );
      });
      expect(toggle.disabled).toBe(false);
      expect(document.activeElement).toBe(toggle);
      expect(
        page.querySelector<HTMLInputElement>('[data-test-id="cron-row-toggle-other"] input')
          ?.disabled,
      ).toBe(true);
      toggle.click();
      expect(request.mock.calls.filter(([method]) => method === "cron.update")).toHaveLength(1);
      // The visual expected value never becomes synchronous domain authority.
      expect(page.cron.cronJobs[0]?.enabled).toBe(true);
      if (accepted) {
        serverJob = { ...job, enabled: false, updatedAtMs: 2, configRevision: "paused" };
        reconciling = true;
        update.resolve(serverJob);
        await waitForSolid(() =>
          expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
            readsBeforePause + 1,
          ),
        );
        expect(toggle.disabled).toBe(false);
        expect(toggle.getAttribute("aria-disabled")).toBe("true");
        expect(document.activeElement).toBe(toggle);
        refreshed.resolve(cronListResponse([serverJob, otherJob]));
      } else {
        update.reject(new Error("Gateway declined the pause"));
      }
      await waitForSolid(() => {
        expect(
          page.querySelector<HTMLInputElement>(selector)?.getAttribute("aria-disabled"),
        ).toBeNull();
        expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(!accepted);
      });
      expect(page.querySelector('[data-test-id="cron-row-optimistic"]')).toBe(row);
      expect(document.activeElement).toBe(toggle);
      expect(toggle.disabled).toBe(false);
      disabledChanges.push(...observer.takeRecords());
      observer.disconnect();
      expect(disabledChanges).toHaveLength(0);
      if (!accepted) {
        expect(page.textContent).toContain("Gateway declined the pause");
      }
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
        readsBeforePause + (accepted ? 1 : 0),
      );
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
    let retry: HTMLButtonElement | undefined;
    await waitForSolid(() => {
      retry = Array.from(page.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      );
      expect(retry).toBeDefined();
    });
    const readsBeforeRetry = request.mock.calls.filter(([method]) => method === "cron.list").length;
    failed = false;
    retry!.click();
    await waitForSolid(() =>
      expect(page.querySelector('[data-test-id="cron-row-retried"]')).not.toBeNull(),
    );
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
      readsBeforeRetry + 1,
    );
    expect(page.textContent).not.toContain("List unavailable");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("ASYNC_OUTSIDE_LOADING_BOUNDARY");
  } finally {
    warn.mockRestore();
    page.remove();
  }
});

it("saves an edited automation and confirms its removal through the native actions", async () => {
  let serverJob = createCronViewJob("editable", { name: "Garden reminder" });
  let removed = false;
  const request = cronRpc({
    "cron.list": () => cronListResponse(removed ? [] : [{ ...serverJob }]),
    "cron.get": () => ({ ...serverJob }),
    "cron.update": () => {
      serverJob = { ...serverJob, name: "Evening garden reminder", configRevision: "edited" };
      return { ...serverJob };
    },
    "cron.remove": () => {
      removed = true;
      return {};
    },
  });
  const { page } = mountCronPage(request);
  try {
    await waitForSolid(() =>
      expect(page.querySelector('[data-test-id="cron-row-editable"]')).not.toBeNull(),
    );
    page.querySelector<HTMLElement>('[data-test-id="cron-row-editable"]')!.click();
    await waitForSolid(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    const name = page.querySelector<HTMLInputElement>("#cron-name")!;
    name.value = "Evening garden reminder";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await page.settle();
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-submit"]')!.click();
    await waitForSolid(() => {
      expect(page.cron.cronEditingJob?.name).toBe("Evening garden reminder");
      expect(page.querySelector<HTMLButtonElement>('[data-test-id="cron-submit"]')?.disabled).toBe(
        false,
      );
    });
    expect(request).toHaveBeenCalledWith(
      "cron.update",
      expect.objectContaining({
        id: "editable",
        expectedConfigRevision: "config-revision-editable",
        patch: expect.objectContaining({ name: "Evening garden reminder" }),
      }),
    );
    await openCronMenu(page, ".cron-job-menu");
    getButtonByText(page, "Remove").click();
    expect(request.mock.calls.some(([method]) => method === "cron.remove")).toBe(false);
    getButtonByText(await waitForConfirmDialogActions(), "Remove").click();
    await waitForSolid(() => {
      expect(page.cron.cronEditingJob).toBeNull();
      expect(page.cron.cronJobs).toEqual([]);
      expect(page.querySelector('[data-test-id="cron-new-task"]')).not.toBeNull();
    });
    expect(request).toHaveBeenCalledWith("cron.remove", { id: "editable" });
  } finally {
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
        expect(page.querySelector<HTMLInputElement>(selector)?.getAttribute("aria-disabled")).toBe(
          "true",
        );
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
        expect(
          page.querySelector<HTMLInputElement>(selector)?.getAttribute("aria-disabled"),
        ).toBeNull();
      });
      paused.resolve({ ...initialJob, enabled: false });
      await page.settle();
      expect(page.querySelector<HTMLInputElement>(selector)?.checked).toBe(true);
      expect(
        page.querySelector<HTMLInputElement>(selector)?.getAttribute("aria-disabled"),
      ).toBeNull();
    } finally {
      paused.resolve({ ...initialJob, enabled: false });
      page.remove();
    }
  },
);
