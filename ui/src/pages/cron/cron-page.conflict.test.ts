import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronJob } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { createCronViewJob } from "./view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("automation revision conflict recovery", () => {
  it.each(["save", "toggle"] as const)(
    "recovers a conflicted %s outside active filters before a deliberate retry",
    async (operation) => {
      const staleJob: CronJob = {
        id: "filtered-conflict-job",
        name: "Loaded name",
        description: "Loaded description",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 1,
        configRevision: "revision-stale",
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "digest" },
        state: {},
      };
      const authoritativeJob: CronJob = {
        ...staleJob,
        name: "Authoritative name",
        description: "Latest Gateway definition",
        updatedAtMs: 2,
        configRevision: "revision-current",
      };
      const conflict = Object.assign(new Error("cron job definition changed"), {
        details: { code: "CRON_JOB_CHANGED" },
      });
      let updates = 0;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "cron.list") {
          const query = (params as { query?: string } | undefined)?.query;
          return query === "missing from filtered results"
            ? cronListResponse([])
            : cronListResponse([staleJob]);
        }
        if (method === "cron.update") {
          updates += 1;
          if (updates === 1) {
            throw conflict;
          }
          return { ...authoritativeJob, enabled: false, configRevision: "revision-retried" };
        }
        if (method === "cron.get") {
          return authoritativeJob;
        }
        if (method === "cron.status") {
          return { enabled: true, jobs: 1 };
        }
        if (method === "cron.runs") {
          return { entries: [], total: 0, offset: 0, hasMore: false };
        }
        if (method === "models.list") {
          return { models: [] };
        }
        return {};
      });
      const gateway = createGateway(createTestGatewayClient(request), true);
      const page = createPage(createContext(gateway), { render: true });

      await waitForCronPage(() =>
        expect(
          page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]'),
        ).not.toBeNull(),
      );
      (
        page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]') as HTMLElement
      ).click();
      await waitForCronPage(() => expect(page.cron.cronEditingJob?.id).toBe(staleJob.id));

      page.cron.cronJobsQuery = "missing from filtered results";
      page.refreshView();
      await page.settle();
      const name = page.querySelector("#cron-name") as HTMLInputElement;
      name.value = "My stale edit";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      const action =
        operation === "save"
          ? '[data-test-id="cron-submit"]'
          : '[data-test-id="cron-toggle-enabled"] input';
      gateway.emitRetiredEvent({ type: "event", event: "cron", payload: {} });
      await waitForCronPage(() => expect(page.cron.cronJobs).toEqual([]));
      await page.settle();
      expect(name.value).toBe("My stale edit");
      expect(page.cron.cronEditingJob?.configRevision).toBe("revision-stale");
      (page.querySelector(action) as HTMLInputElement).click();

      await waitForCronPage(() =>
        expect(page.cron.cronEditingJob?.configRevision).toBe("revision-current"),
      );
      expect(page.cron.cronEditingJob).toEqual(authoritativeJob);
      expect(request).toHaveBeenCalledWith(
        "cron.list",
        expect.objectContaining({ query: "missing from filtered results" }),
      );
      expect(request).toHaveBeenCalledWith("cron.get", { id: staleJob.id });
      expect(page.cron.cronJobs).toEqual([]);
      expect(page.cron.cronJobsTotal).toBe(0);
      expect((page.querySelector("#cron-name") as HTMLInputElement).value).toBe(
        authoritativeJob.name,
      );
      expect(page.querySelector(".cron-detail-title")?.textContent).toContain(
        authoritativeJob.name,
      );
      expect(page.querySelector('[data-test-id="cron-detail-description"]')?.textContent).toContain(
        authoritativeJob.description,
      );
      expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();
      expect(page.querySelector(".cron-error-banner")?.textContent).toContain(
        "review it before retrying",
      );
      expect(updates).toBe(1);
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      (page.querySelector(action) as HTMLInputElement).click();
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      expect(updates).toBe(2);
      expect(
        request.mock.calls
          .filter(([method]) => method === "cron.update")
          .map(([, params]) => params),
      ).toEqual([
        expect.objectContaining({ expectedConfigRevision: "revision-stale" }),
        expect.objectContaining({ expectedConfigRevision: "revision-current" }),
      ]);
      expect(page.querySelector(".cron-error-banner")).toBeNull();

      (page.querySelector('[data-test-id="cron-back"]') as HTMLButtonElement).click();
      await waitForCronPage(() => expect(page.cron.cronEditingJob).toBeNull());
      expect(page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]')).toBeNull();
    },
  );

  it.each(["another automation", "reopened editor", "Gateway source"] as const)(
    "keeps %s intact when a rejected toggle's definition read settles",
    async (navigation) => {
      const job = createCronViewJob("conflict-origin", {
        name: "Original automation",
        configRevision: "stale",
      });
      const other = createCronViewJob("new-selection", {
        name: "New selection",
        configRevision: "other",
      });
      const latest = { ...job, name: "Latest original", configRevision: "current" };
      const pending = createDeferred<CronJob>();
      const reading = createDeferred();
      const fallback = createRequest();
      let exactReads = 0;
      const request = vi.fn(async (method: string) => {
        if (method === "cron.list") {
          return cronListResponse([job, other]);
        }
        if (method === "cron.update") {
          throw Object.assign(new Error("Definition changed"), {
            details: { code: "CRON_JOB_CHANGED" },
          });
        }
        if (method === "cron.get") {
          exactReads += 1;
          if (exactReads === 2) {
            reading.resolve();
            return pending.promise;
          }
          return job;
        }
        return fallback(method);
      });
      const page = createPage(
        createContext(createGateway(createTestGatewayClient(request), true)),
        { render: true },
      );
      try {
        await waitForCronPage(() =>
          expect(page.querySelector('[data-test-id="cron-row-conflict-origin"]')).not.toBeNull(),
        );
        page.querySelector<HTMLElement>('[data-test-id="cron-row-conflict-origin"]')!.click();
        await page.settle();
        const originalState = page.cron;
        page.querySelector<HTMLInputElement>('[data-test-id="cron-toggle-enabled"] input')!.click();
        await reading.promise;
        if (navigation === "Gateway source") {
          page.context = createContext(
            createGateway(createTestGatewayClient(createRequest()), true),
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
        await waitForCronPage(() => expect(originalState.cronBusy).toBe(false));
        await page.settle();
        expect(page.cron.cronEditingJob).toBe(selected);
        expect(page.cron.cronForm).toBe(draft);
        expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
          "Newer unsaved intent",
        );
        expect(page.querySelector(".cron-error-banner")?.textContent).toBe("Newer editor feedback");
        expect(request.mock.calls.filter(([method]) => method === "cron.update")).toHaveLength(1);
      } finally {
        pending.resolve(latest);
        page.remove();
      }
    },
  );
});
