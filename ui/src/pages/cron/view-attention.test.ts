import { expect, it } from "vitest";
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
  const container = await renderView({ editingJob: job });
  expect(container.querySelector('[data-test-id="cron-toggle-enabled"]')?.textContent).toContain(
    "Auto-disabled",
  );
  const warning = container.querySelector(".cron-failure-details");
  expect(warning?.textContent).toContain("Provider rejected the request");
  expect(warning?.textContent).toContain("No response was recorded");
  expect(warning?.textContent).toContain("Check for completed actions before running again");
  expect(warning?.textContent).not.toContain("Paused");
});

it("does not flag a manually paused historical error as an active failure", async () => {
  const job = createJob("paused", {
    enabled: false,
    state: { lastRunStatus: "error", lastError: "Historical failure" },
  });
  const container = await renderView({ editingJob: job });
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
  const container = await renderView({ editingJob: job });
  const warning = container.querySelector(".cron-failure-details");
  expect(warning?.textContent).toContain("Next run is scheduled");
  expect(warning?.textContent).not.toContain("No further run");
  expect(warning?.textContent).not.toContain("will not retry");
});

it("shows a run already in progress rather than implying that scheduling stopped", async () => {
  const job = createJob("running", {
    state: { lastRunStatus: "error", runningAtMs: 10, lastError: "Previous failure" },
  });
  const container = await renderView({ editingJob: job });
  const warning = container.querySelector(".cron-failure-details");
  expect(warning?.textContent).toContain("A new run is in progress");
  expect(warning?.textContent).not.toContain("No further run");
});
