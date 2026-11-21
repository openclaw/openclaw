import { expect, it } from "vitest";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

it("distinguishes automatic shutdown from a manual pause in detail", async () => {
  const job = createJob("auto-disabled", {
    enabled: false,
    state: {
      autoDisabled: { reason: "consecutive-failures", atMs: 10, consecutiveErrors: 10 },
      lastRunStatus: "error",
      lastError: "Provider rejected the request",
      lastDiagnosticSummary: "No response was recorded",
    },
  });
  const container = await renderView({ editingJob: job, detailTab: "history" });
  expect(container.querySelector('[data-test-id="cron-toggle-enabled"]')?.textContent).toContain(
    "Turned off",
  );
  // The raw cause stays collapsed until asked for.
  expect(container.querySelector(".cron-error-details__text")).toBeNull();
  container
    .querySelector<HTMLButtonElement>('[data-test-id="cron-failure-details-toggle"]')!
    .click();
  flush();
  const warning = container.querySelector(".cron-failure-details");
  expect(warning?.textContent).toContain("Provider rejected the request");
  expect(warning?.textContent).toContain("No response was recorded");
  // Why it is off and the one action that resumes it, without the raw cause.
  expect(warning?.textContent).toContain("Turned off after 10 failed runs in a row");
  expect(warning?.textContent).toContain("Fix the cause, then switch Active back on to resume.");
  expect(warning?.textContent).not.toContain("Paused");
});

it("names what a source-unavailable stop lost and how to restore it", async () => {
  const job = createJob("archived", {
    enabled: false,
    state: {
      autoDisabled: {
        reason: "source-unavailable",
        atMs: 10,
        consecutiveErrors: 0,
        gone: "conversation",
      },
      lastRunStatus: "error",
    },
  });
  const container = await renderView({ editingJob: job, detailTab: "history" });
  const warning = container.querySelector(".cron-failure-details")?.textContent;
  expect(warning).toContain(
    "Turned off because the conversation it runs in was archived or deleted",
  );
  expect(warning).toContain("Restore the conversation or move the automation to another one");
});

it("does not flag a manually paused historical error as an active failure", async () => {
  const job = createJob("paused", {
    enabled: false,
    state: { lastRunStatus: "error", lastError: "Historical failure" },
  });
  const container = await renderView({ editingJob: job, detailTab: "history" });
  expect(container.querySelector('[data-test-id="cron-toggle-enabled"]')?.textContent).toContain(
    "Paused",
  );
  expect(container.querySelector(".cron-failure-details")).toBeNull();
});

it("does not imply that a recurring failure with a next run has stopped", async () => {
  const job = createJob("recurring", {
    state: {
      lastRunStatus: "error",
      nextRunAtMs: Date.UTC(2026, 10, 5),
      lastError: "Temporary provider failure",
    },
  });
  const container = await renderView({ editingJob: job, detailTab: "history" });
  const warning = container.querySelector(".cron-failure-details");
  expect(warning?.textContent).toContain("Next run is scheduled");
  expect(warning?.textContent).not.toContain("No further run");
  expect(warning?.textContent).not.toContain("will not retry");
});

it("shows a run already in progress rather than implying that scheduling stopped", async () => {
  const job = createJob("running", {
    state: { lastRunStatus: "error", runningAtMs: 10, lastError: "Previous failure" },
  });
  const container = await renderView({ editingJob: job, detailTab: "history" });
  const warning = container.querySelector(".cron-failure-details");
  expect(warning?.textContent).toContain("A new run is in progress");
  expect(warning?.textContent).not.toContain("No further run");
});
