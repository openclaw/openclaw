import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import * as dom from "./cron-assertions.test-support.ts";
import * as harness from "./cron-page.test-support.tsx";
import { cronRpc } from "./cron-rpc.test-support.ts";
import { createCronViewJob, scheduledJob } from "./view.test-support.ts";

const changedDefinition = () =>
  Object.assign(new Error("Definition changed"), {
    details: { code: "CRON_JOB_CHANGED" },
  });
function conflictPage(request: ReturnType<typeof cronRpc>) {
  const gateway = harness.createGateway(createTestGatewayClient(request), true);
  return { gateway, page: harness.createPage(harness.createContext(gateway), { render: true }) };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["save", "toggle"] as const)(
  "recovers a conflicted %s outside active filters before a deliberate retry",
  async (operation) => {
    const staleJob = scheduledJob("filtered-conflict-job", {
      name: "Loaded name",
      updatedAtMs: 1,
      configRevision: "revision-stale",
      schedule: { kind: "cron", expr: "0 9 * * *" },
    });
    const authoritativeJob: CronJob = {
      ...staleJob,
      name: "Authoritative name",
      description: "Latest Gateway definition",
      updatedAtMs: 2,
      configRevision: "revision-current",
    };
    let updates = 0;
    const request = cronRpc({
      "cron.list": (params) => {
        const query = (params as { query?: string } | undefined)?.query;
        return query === "missing from filtered results"
          ? harness.cronListResponse([])
          : harness.cronListResponse([staleJob]);
      },
      "cron.update": () => {
        updates += 1;
        if (updates === 1) {
          throw changedDefinition();
        }
        return { ...authoritativeJob, enabled: false, configRevision: "revision-retried" };
      },
      "cron.get": () => authoritativeJob,
      "cron.status": () => ({ enabled: true, jobs: 1 }),
    });
    const { gateway, page } = conflictPage(request);

    (await dom.waitForElement(page, dom.testId("cron-row-filtered-conflict-job"))).click();
    await harness.waitForCronPage(() => expect(page.cron.cronEditingJob?.id).toBe(staleJob.id));

    page.cron.cronJobsQuery = "missing from filtered results";
    page.refreshView();
    await page.settle();
    const name = dom.fillInput(page, "#cron-name", "My stale edit");
    const action =
      operation === "save"
        ? dom.testId("cron-submit")
        : '[data-test-id="cron-toggle-enabled"] input';
    gateway.emitRetiredEvent({ type: "event", event: "cron", payload: {} });
    await harness.waitForCronPage(() => expect(page.cron.cronJobs).toEqual([]));
    await page.settle();
    expect(name.value).toBe("My stale edit");
    expect(page.cron.cronEditingJob?.configRevision).toBe("revision-stale");
    dom.click(page, action);

    await harness.waitForCronPage(() =>
      expect(page.cron.cronEditingJob?.configRevision).toBe("revision-current"),
    );
    expect(page.cron.cronEditingJob).toEqual(authoritativeJob);
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ query: "missing from filtered results" }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: staleJob.id });
    expect(page.cron).toMatchObject({ cronJobs: [], cronJobsTotal: 0 });
    expect(dom.inputValue(page, "#cron-name")).toBe(authoritativeJob.name);
    expect(dom.text(page, ".cron-detail-title")).toContain(authoritativeJob.name);
    expect(dom.text(page, dom.testId("cron-detail-description"))).toContain(
      authoritativeJob.description,
    );
    expect(page.querySelector(dom.testId("cron-detail-tab-history"))).not.toBeNull();
    expect(dom.text(page, ".cron-error-banner")).toContain("review it before retrying");
    expect(updates).toBe(1);
    await harness.waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
    dom.click(page, action);
    await harness.waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
    expect(updates).toBe(2);
    expect(
      request.mock.calls.filter(([method]) => method === "cron.update").map(([, params]) => params),
    ).toEqual([
      expect.objectContaining({ expectedConfigRevision: "revision-stale" }),
      expect.objectContaining({ expectedConfigRevision: "revision-current" }),
    ]);
    expect(page.querySelector(".cron-error-banner")).toBeNull();

    dom.click(page, dom.testId("cron-back"));
    await harness.waitForCronPage(() => expect(page.cron.cronEditingJob).toBeNull());
    expect(page.querySelector(dom.testId("cron-row-filtered-conflict-job"))).toBeNull();
  },
);

it.each(["another automation", "reopened editor", "Gateway source"] as const)(
  "keeps %s intact when a rejected toggle's definition read settles",
  async (navigation) => {
    const job = createCronViewJob("conflict-origin", { configRevision: "stale" });
    const other = createCronViewJob("new-selection", { configRevision: "other" });
    const latest = { ...job, name: "Latest original", configRevision: "current" };
    const pending = createDeferred<CronJob>();
    const reading = createDeferred();

    let exactReads = 0;
    const request = cronRpc({
      "cron.list": () => harness.cronListResponse([job, other]),
      "cron.update": () => {
        throw changedDefinition();
      },
      "cron.get": () => {
        exactReads += 1;
        if (exactReads === 2) {
          reading.resolve();
          return pending.promise;
        }
        return job;
      },
    });
    const { page } = conflictPage(request);
    try {
      (await dom.waitForElement(page, dom.testId("cron-row-conflict-origin"))).click();
      await page.settle();
      const originalState = page.cron;
      dom.click(page, '[data-test-id="cron-toggle-enabled"] input');
      await reading.promise;
      if (navigation === "Gateway source") {
        page.context = harness.createContext(
          harness.createGateway(createTestGatewayClient(harness.createRequest()), true),
        );
        page.refreshView();
      } else if (navigation === "reopened editor") {
        page.closePanel();
      }
      page.selectJob(navigation === "reopened editor" ? job : other);
      await page.settle();
      page.patchForm({ name: "Newer unsaved intent" });
      page.cron.cronError = "Newer editor feedback";
      page.refreshView();
      const selected = page.cron.cronEditingJob;
      const draft = page.cron.cronForm;
      pending.resolve(latest);
      await harness.waitForCronPage(() => expect(originalState.cronBusy).toBe(false));
      await page.settle();
      expect(page.cron.cronEditingJob).toBe(selected);
      expect(page.cron.cronForm).toBe(draft);
      expect(dom.inputValue(page, "#cron-name")).toBe("Newer unsaved intent");
      expect(dom.text(page, ".cron-error-banner")).toBe("Newer editor feedback");
      dom.expectCalls(request, ["cron.update"], 1);
    } finally {
      pending.resolve(latest);
      page.remove();
    }
  },
);
