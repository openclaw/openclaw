import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { waitForCronPage } from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

it("opens a job-only failure link on its recorded run without replaying it", async () => {
  const job = createCronViewJob("failed-once", {
    schedule: { kind: "at", at: "2026-11-01T10:00:00.000Z" },
    state: {
      lastRunStatus: "error",
      lastRunAtMs: 10,
      lastError: "Run interrupted before completion",
    },
  });
  const { page, client } = mountCronPage(
    cronRpc({
      "cron.get": () => job,
      "cron.runs": () => ({
        entries: [
          {
            jobId: job.id,
            runId: "receipt-1",
            runAtMs: 10,
            ts: 11,
            action: "finished",
            status: "error",
            error: job.state.lastError,
          },
        ],
        total: 1,
        offset: 0,
        hasMore: false,
      }),
    }),
  );
  try {
    page.routeSearch = `?job=${job.id}`;
    await waitForCronPage(() =>
      expect(page.querySelector(".cron-run-entry--highlighted")).not.toBeNull(),
    );
    const warning = () => page.querySelector<HTMLElement>(".cron-failure-details");
    expect(warning()?.textContent).toContain(job.state.lastError);
    expect(warning()?.textContent).toContain("No further run is scheduled");
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-detail-tab-settings"]')?.click();
    await page.settle();
    expect(warning()?.textContent).toContain("No further run is scheduled");
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-review-failed-run"]')?.click();
    await page.settle();
    expect(page.querySelector(".cron-run-entry--highlighted")).not.toBeNull();
    const methods = vi.mocked(client).request.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("cron.run");
    expect(methods).not.toContain("cron.update");
    expect(
      vi
        .mocked(client)
        .request.mock.calls.some(
          ([method, params]) =>
            method === "cron.runs" && asOptionalRecord(params)?.runId === "cron:failed-once:10",
        ),
    ).toBe(true);
  } finally {
    page.remove();
  }
});

it("keeps an explicit older run link instead of replacing it with the latest failure", async () => {
  const job = createCronViewJob("failed-job", {
    state: { lastRunStatus: "error", lastRunAtMs: 20, lastError: "Latest failure" },
  });
  const { page, client } = mountCronPage(cronRpc({ "cron.get": () => job }));
  try {
    page.routeSearch = "?job=failed-job&run=older-receipt";
    await waitForCronPage(() =>
      expect(
        vi
          .mocked(client)
          .request.mock.calls.some(
            ([method, params]) =>
              method === "cron.runs" && asOptionalRecord(params)?.runId === "older-receipt",
          ),
      ).toBe(true),
    );
    expect(page.querySelector(".cron-failure-details")?.textContent).toContain("Latest failure");
    expect(
      vi
        .mocked(client)
        .request.mock.calls.some(
          ([method, params]) =>
            method === "cron.runs" && asOptionalRecord(params)?.runId === "cron:failed-job:20",
        ),
    ).toBe(false);
  } finally {
    page.remove();
  }
});

it("clears stale history filters for an attention job without a recorded run id", async () => {
  const job = createCronViewJob("missing-run-id", {
    state: { lastRunStatus: "error", lastError: "Run failed" },
  });
  const { page, client } = mountCronPage(cronRpc({ "cron.get": () => job }));
  try {
    await page.settle();
    page.cron.cronRunsQuery = "unrelated search";
    page.cron.cronRunsStatuses = ["ok"];
    page.cron.cronRunsDeliveryStatuses = ["delivered"];
    page.routeSearch = `?job=${job.id}`;
    await waitForCronPage(() =>
      expect(
        page
          .querySelector('[data-test-id="cron-detail-tab-history"]')
          ?.getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(page.cron.cronRunsQuery).toBe("");
    expect(page.cron.cronRunsStatuses).toEqual([]);
    expect(page.cron.cronRunsDeliveryStatuses).toEqual([]);
    expect(
      vi
        .mocked(client)
        .request.mock.calls.some(([method]) => method === "cron.run" || method === "cron.update"),
    ).toBe(false);
    page.closePanel();
    const paused = createCronViewJob("paused-job", {
      enabled: false,
      state: { lastRunStatus: "error", lastRunAtMs: 10 },
    });
    page.selectJob(paused);
    await page.settle();
    expect(
      page
        .querySelector('[data-test-id="cron-detail-tab-settings"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(page.querySelector(".cron-failure-details")).toBeNull();
  } finally {
    page.remove();
  }
});
