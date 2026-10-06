import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { removeCronJob } from "../../lib/cron/index.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage pending action labels", () => {
  const SAVE_LABEL = "Save changes";
  const SAVING_LABEL = "Saving...";

  function createPendingPage(method: string) {
    const job = createCronViewJob("job-1", { name: "Nightly digest" });
    const reply = createDeferred<unknown>();
    const fallback = createRequest();
    const request = vi.fn(async (requestMethod: string) => {
      if (requestMethod === "cron.list") {
        return cronListResponse([job]);
      }
      if (requestMethod === method) {
        return reply.promise;
      }
      return fallback(requestMethod);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway), { render: true });
    return { page, reply, job };
  }

  async function selectJob(page: ReturnType<typeof createPage>) {
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-job-1"]')).not.toBeNull(),
    );
    (
      page.querySelector('[data-test-id="cron-row-job-1"] .cron-table__name') as HTMLButtonElement
    ).click();
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
  }

  async function waitForPending(page: ReturnType<typeof createPage>) {
    await waitForCronPage(() => expect(page.cron.cronBusy).toBe(true));
    await page.updateComplete;
  }

  function labels(page: ReturnType<typeof createPage>) {
    return {
      submit: page.querySelector('[data-test-id="cron-submit"]')?.textContent ?? "",
      submitDisabled: (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement)
        .disabled,
      runNow: page.querySelector('[data-test-id="cron-run-now"]')?.textContent ?? "",
      runNowDisabled: (page.querySelector('[data-test-id="cron-run-now"]') as HTMLButtonElement)
        .disabled,
    };
  }

  it("shows the idle Run now label while the run history refresh is still pending", async () => {
    // cron.run settles before the history read it triggers. The mutation lock stays
    // held across that read, so the pending-action label has to be published on the
    // request's own settle — waiting for the whole chain leaves Run claiming
    // "Starting…" for as long as cron.runs takes.
    const job = createCronViewJob("job-1", { name: "Nightly digest" });
    const run = createDeferred<unknown>();
    const runs = createDeferred<unknown>();
    const fallback = createRequest();
    const request = vi.fn(async (requestMethod: string) => {
      if (requestMethod === "cron.list") {
        return cronListResponse([job]);
      }
      if (requestMethod === "cron.run") {
        return run.promise;
      }
      if (requestMethod === "cron.runs") {
        return runs.promise;
      }
      return fallback(requestMethod);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway), { render: true });
    try {
      await selectJob(page);
      (page.querySelector('[data-test-id="cron-run-now"]') as HTMLButtonElement).click();
      await waitForPending(page);
      expect(labels(page).runNow).toContain("Starting");

      run.resolve({ ok: true, ran: true });
      // Settle the run, then assert without ever resolving the history read: the
      // idle label is the only thing that can satisfy this.
      await waitForCronPage(() => expect(page.cron.cronPendingAction).toBeNull());
      await page.updateComplete;
      const settled = labels(page);
      expect(settled.runNow).toContain("Run now");
      expect(settled.runNow).not.toContain("Starting");
      // The lock is genuinely still held by the pending read, so the button stays
      // disabled — this is a relabel, not an early unlock.
      expect(page.cron.cronBusy).toBe(true);
      expect(settled.runNowDisabled).toBe(true);
    } finally {
      run.resolve({ ok: true, ran: true });
      runs.resolve({ entries: [], total: 0, offset: 0, hasMore: false });
      await page.updateComplete;
      page.remove();
    }
  });

  it("announces a run without relabelling an untouched save", async () => {
    const { page, reply } = createPendingPage("cron.run");
    try {
      await selectJob(page);
      (page.querySelector('[data-test-id="cron-run-now"]') as HTMLButtonElement).click();
      await waitForPending(page);

      const pending = labels(page);
      // The mutation lock still holds both controls...
      expect(pending.submitDisabled).toBe(true);
      expect(pending.runNowDisabled).toBe(true);
      // ...while only the run announces itself.
      expect(pending.submit).toContain(SAVE_LABEL);
      expect(pending.submit).not.toContain(SAVING_LABEL);
      expect(pending.runNow).toContain("Starting");
      expect(page.cron.cronPendingAction).toBe("run");

      reply.resolve({ ok: true, ran: true });
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      await page.updateComplete;
      const idle = labels(page);
      expect(page.cron.cronPendingAction).toBeNull();
      expect(idle.submit).toContain(SAVE_LABEL);
      expect(idle.runNow).toContain("Run now");
      expect(idle.submitDisabled).toBe(false);
    } finally {
      reply.resolve({ ok: true, ran: true });
      page.remove();
    }
  });

  it("restores both idle labels when a pending run is rejected", async () => {
    const { page, reply } = createPendingPage("cron.run");
    try {
      await selectJob(page);
      (page.querySelector('[data-test-id="cron-run-now"]') as HTMLButtonElement).click();
      await waitForPending(page);
      expect(labels(page).submit).toContain(SAVE_LABEL);

      reply.reject(new Error("Synthetic run failure"));
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      await page.updateComplete;
      expect(page.cron.cronPendingAction).toBeNull();
      const idle = labels(page);
      expect(idle.submit).toContain(SAVE_LABEL);
      expect(idle.runNow).toContain("Run now");
      expect(idle.runNowDisabled).toBe(false);
    } finally {
      reply.reject(new Error("Synthetic run failure"));
      page.remove();
    }
  });

  it("keeps another automation's run label idle while a run is held elsewhere", async () => {
    // Row selection has no busy guard, so selecting a second automation while a
    // run is in flight is ordinary clicking. The lock is page-wide, so the label
    // has to be scoped to the automation that was actually started.
    const started = createCronViewJob("job-1", { name: "Nightly digest" });
    const other = createCronViewJob("job-2", { name: "Weekly report" });
    const reply = createDeferred<unknown>();
    const fallback = createRequest();
    const request = vi.fn(async (requestMethod: string) => {
      if (requestMethod === "cron.list") {
        return cronListResponse([started, other]);
      }
      if (requestMethod === "cron.run") {
        return reply.promise;
      }
      return fallback(requestMethod);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() =>
        expect(page.querySelector('[data-test-id="cron-row-job-1"]')).not.toBeNull(),
      );
      // Start the run from the list row, which is the path that leaves a
      // different automation selected behind it.
      (page.querySelector('[data-test-id="cron-row-run-job-1"]') as HTMLButtonElement).click();
      await waitForPending(page);
      expect(page.cron.cronPendingRunJobId).toBe("job-1");

      // Now select the other automation while that run is still held.
      (
        page.querySelector('[data-test-id="cron-row-job-2"] .cron-table__name') as HTMLButtonElement
      ).click();
      await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
      await page.updateComplete;
      const switched = labels(page);
      // Disabled, because the shared lock is genuinely held...
      expect(switched.runNowDisabled).toBe(true);
      // ...but idle, because nothing was started for this automation.
      expect(switched.runNow).toContain("Run now");
      expect(switched.runNow).not.toContain("Starting");
    } finally {
      reply.resolve({ ok: true, ran: true });
      await page.updateComplete;
      page.remove();
    }
  });

  it("keeps an untouched save idle while a remove holds the lock", async () => {
    const { page, reply, job } = createPendingPage("cron.remove");
    try {
      await selectJob(page);
      void removeCronJob(page.cron, job);
      page.requestUpdate();
      await waitForPending(page);

      const pending = labels(page);
      expect(pending.submitDisabled).toBe(true);
      expect(pending.submit).toContain(SAVE_LABEL);
      expect(pending.submit).not.toContain(SAVING_LABEL);
      expect(pending.runNow).toContain("Run now");
      expect(page.cron.cronPendingAction).toBe("remove");

      reply.resolve({ removed: true });
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      await page.updateComplete;
      expect(page.cron.cronPendingAction).toBeNull();
    } finally {
      reply.resolve({ removed: true });
      page.remove();
    }
  });

  it("still announces a save while a save holds the lock", async () => {
    const { page, reply } = createPendingPage("cron.update");
    try {
      await selectJob(page);
      (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();
      await waitForPending(page);

      const pending = labels(page);
      expect(pending.submitDisabled).toBe(true);
      expect(pending.submit).toContain(SAVING_LABEL);
      expect(pending.runNow).toContain("Run now");
      expect(page.cron.cronPendingAction).toBe("save");

      reply.resolve({ ...createCronViewJob("job-1", { name: "Nightly digest" }) });
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      await page.updateComplete;
      expect(page.cron.cronPendingAction).toBeNull();
      const idle = labels(page);
      expect(idle.submit).toContain(SAVE_LABEL);
      expect(idle.submitDisabled).toBe(false);
    } finally {
      reply.resolve({ ...createCronViewJob("job-1", { name: "Nightly digest" }) });
      page.remove();
    }
  });
});
