// Auto-disabled state rendering for the Automations (cron) table.
// Lives beside view.test.ts, which sits at the max-lines cap.
import { expect, it, vi } from "vitest";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

it("labels an auto-disabled job distinctly from an operator pause", async () => {
  const paused = createJob("job-paused", { enabled: false });
  const autoDisabled = createJob("job-auto", {
    enabled: false,
    state: {
      lastRunStatus: "error",
      lastError: "provider exploded",
      autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
    },
  });
  const container = await renderView({ jobs: [paused, autoDisabled] });
  const pausedRow = container.querySelector("[data-test-id='cron-row-job-paused']");
  expect(pausedRow?.textContent).toContain("Paused");
  expect(pausedRow?.querySelector(".cron-table__state--paused")?.getAttribute("aria-label")).toBe(
    "Paused",
  );
  const autoDisabledRow = container.querySelector("[data-test-id='cron-row-job-auto']");
  const note = autoDisabledRow?.querySelector("[data-test-id='cron-row-auto-disabled-job-auto']");
  expect(note?.textContent?.trim()).toBe("Auto-disabled · 10 run failures");
  expect(note?.getAttribute("title")).toBe("provider exploded");
  // Escalated failure keeps a visible error marker even though the job is disabled.
  expect(
    autoDisabledRow?.querySelector(".cron-table__state--error")?.getAttribute("aria-label"),
  ).toBe("Auto-disabled · 10 run failures");
});

it("keeps flat rows with a leading toggle and independent actions", async () => {
  const job = createJob("failed", {
    state: { lastRunStatus: "error", lastError: "Provider rejected the request" },
  });
  const onToggle = vi.fn();
  const onRun = vi.fn();
  const onSelectJob = vi.fn();
  const container = await renderView({ jobs: [job], onToggle, onRun, onSelectJob });
  const row = container.querySelector<HTMLElement>('[data-test-id="cron-row-failed"]')!;
  expect(container.querySelector(".cron-table__head")).toBeNull();
  expect(container.textContent).not.toContain("Needs attention");
  expect(row.closest(".settings-section")).toBeNull();
  expect(
    row.firstElementChild?.querySelector('[data-test-id="cron-row-toggle-failed"]'),
  ).not.toBeNull();
  const name = row.querySelector(".cron-table__name");
  expect(name?.querySelector(".cron-table__schedule")?.textContent).toContain("Cron 0 9 * * *");
  expect(name?.textContent).toContain("Last run failed");
  expect(row.querySelector(".cron-table__next")?.textContent).toContain("No next run scheduled");
  expect(row.querySelector(".cron-job-menu__trigger")).not.toBeNull();
  row.querySelector<HTMLInputElement>('[data-test-id="cron-row-toggle-failed"] input')!.click();
  expect(onToggle).toHaveBeenCalledWith(job, false);
  row.querySelector<HTMLButtonElement>('[data-test-id="cron-row-run-failed"]')!.click();
  expect(onRun).toHaveBeenCalledWith(job, "force");
  expect(onSelectJob).not.toHaveBeenCalled();
});

it("stably promotes active failures while preserving the received order within both groups", async () => {
  const jobs = [
    createJob("healthy-first", { state: { lastRunStatus: "ok", nextRunAtMs: 30 } }),
    createJob("failed-first", { state: { lastRunStatus: "error", nextRunAtMs: 40 } }),
    createJob("paused-error", { enabled: false, state: { lastRunStatus: "error" } }),
    createJob("auto-disabled", {
      enabled: false,
      state: { autoDisabled: { reason: "schedule-errors", atMs: 1, consecutiveErrors: 1 } },
    }),
    createJob("healthy-last", {
      state: { lastRunStatus: "ok", lastStatus: "error", nextRunAtMs: 10 },
    }),
    createJob("legacy-error", { state: { lastStatus: "error", nextRunAtMs: 20 } }),
  ];
  const container = await renderView({ jobs });
  const lists = container.querySelectorAll('[role="list"]');
  expect(lists).toHaveLength(1);
  expect(
    Array.from(lists[0]!.querySelectorAll('[role="listitem"]'), (row) =>
      row.getAttribute("data-test-id"),
    ),
  ).toEqual([
    "cron-row-failed-first",
    "cron-row-auto-disabled",
    "cron-row-legacy-error",
    "cron-row-healthy-first",
    "cron-row-paused-error",
    "cron-row-healthy-last",
  ]);
  expect(jobs.map((job) => job.id)).toEqual([
    "healthy-first",
    "failed-first",
    "paused-error",
    "auto-disabled",
    "healthy-last",
    "legacy-error",
  ]);
});
