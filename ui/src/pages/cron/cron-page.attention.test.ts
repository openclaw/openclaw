import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { waitForCronPage } from "./cron-page.test-support.tsx";
import { cronRpc, emitEvent, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

it("updates an open job's recorded attention across quiet runs, recovery and errors", async () => {
  let job = createCronViewJob("source-check", {
    state: {
      lastRunStatus: "ok",
      lastRunAtMs: 10,
      lastMeaningfulResult: { outcome: "blocked", summary: "Source access required", atMs: 11 },
    },
  });
  const { page, client, gateway } = mountCronPage(
    cronRpc({ "cron.get": () => structuredClone(job) }),
  );
  const warning = () => page.querySelector(".cron-failure-details");
  const publish = async (state: Partial<typeof job.state>) => {
    job = { ...job, state: { ...job.state, ...state }, updatedAtMs: job.updatedAtMs + 1 };
    emitEvent(gateway, "cron", {
      action: "finished",
      jobId: job.id,
      status: job.state.lastRunStatus,
      error: job.state.lastError,
      job: structuredClone(job),
    });
    await page.settle();
  };
  try {
    page.routeSearch = `?job=${job.id}`;
    await waitForCronPage(() => expect(warning()?.textContent).toContain("Source access required"));
    const selectedJob = page.cron.cronEditingJob;
    const blockedPanel = warning();
    for (const lastRunAtMs of [20, 30]) {
      await publish({ lastRunAtMs });
      expect(warning()?.textContent).toContain("Source access required");
      expect(warning()).toBe(blockedPanel);
      expect(page.querySelector('[data-test-id="cron-review-failed-run"]')).toBeNull();
    }
    await publish({
      lastMeaningfulResult: { outcome: "blocked", summary: "Source permission expired", atMs: 35 },
    });
    await waitForCronPage(() =>
      expect(warning()?.textContent).toContain("Source permission expired"),
    );
    expect(warning()?.textContent).not.toContain("Source access required");
    expect(warning()).toBe(blockedPanel);
    expect(page.cron.cronEditingJob).toBe(selectedJob);
    for (const outcome of ["progress", "done"] as const) {
      await publish({ lastMeaningfulResult: { outcome, summary: "Source processed", atMs: 40 } });
      await waitForCronPage(() => expect(warning()).toBeNull());
    }
    await publish({
      lastMeaningfulResult: { outcome: "needs_attention", summary: "Choose the source", atMs: 50 },
    });
    await waitForCronPage(() => expect(warning()?.textContent).toContain("Choose the source"));
    const attentionPanel = warning();
    await publish({ lastRunStatus: "error", lastError: "Execution interrupted" });
    await waitForCronPage(() => expect(warning()?.textContent).toContain("Last run failed"));
    expect(warning()?.textContent).not.toContain("Choose the source");
    expect(warning()).toBe(attentionPanel);
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-failure-details-toggle"]')!.click();
    await page.settle();
    expect(warning()?.textContent).toContain("Execution interrupted");
    const diagnostics = page.querySelector(".cron-error-details__text");
    await publish({ lastError: "Retry budget exhausted" });
    await waitForCronPage(() => expect(warning()?.textContent).toContain("Retry budget exhausted"));
    expect(warning()?.textContent).not.toContain("Execution interrupted");
    expect(warning()).toBe(attentionPanel);
    expect(page.querySelector(".cron-error-details__text")).toBe(diagnostics);
    expect(page.cron.cronEditingJob).toBe(selectedJob);
    const methods = vi.mocked(client).request.mock.calls.map(([method]) => method);
    expect(methods).not.toContain("cron.run");
    expect(methods).not.toContain("cron.update");
  } finally {
    page.remove();
  }
});

it("opens a job-only failure link on its history and reviews the failed run on request", async () => {
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
    // An automation opens on its prompt and history; the failure sits under the prompt.
    await waitForCronPage(() =>
      expect(
        page.querySelector('.cron-page[data-view="detail"] .cron-failure-details'),
      ).not.toBeNull(),
    );
    const warning = () => page.querySelector<HTMLElement>(".cron-failure-details");
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-failure-details-toggle"]')!.click();
    await page.settle();
    expect(warning()?.textContent).toContain(job.state.lastError);
    expect(warning()?.textContent).toContain("No further run is scheduled");
    expect(page.querySelector(".cron-run-entry--highlighted")).toBeNull();
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
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-failure-details-toggle"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-failure-details-toggle"]')!.click();
    await page.settle();
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

it("opens an attention job without a recorded run id on its history, leaving it unrun", async () => {
  const job = createCronViewJob("missing-run-id", {
    state: { lastRunStatus: "error", lastError: "Run failed" },
  });
  const { page, client } = mountCronPage(cronRpc({ "cron.get": () => job }));
  try {
    await page.settle();
    page.routeSearch = `?job=${job.id}`;
    await waitForCronPage(() =>
      expect(page.querySelector('.cron-page[data-view="detail"]')).not.toBeNull(),
    );
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
    expect(page.querySelector('.cron-page[data-view="detail"]')).not.toBeNull();
    expect(page.querySelector(".cron-failure-details")).toBeNull();
  } finally {
    page.remove();
  }
});
