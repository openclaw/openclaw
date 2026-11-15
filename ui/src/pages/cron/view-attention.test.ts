import { expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { resolveCronFailurePhase } from "./view-attention.tsx";
import {
  createCronViewJob as createJob,
  renderCronView as renderView,
} from "./view.test-support.ts";

const NOW = 1_000_000;
const repair = { startedAtMs: NOW - 10, deadlineAtMs: NOW + 10 };

it.each<[string, Partial<CronJob>, ReturnType<typeof resolveCronFailurePhase>]>([
  ["healthy", { state: { lastRunStatus: "ok" } }, undefined],
  ["failing without repair", { state: { lastRunStatus: "error" } }, "failing"],
  [
    "quick re-run pending",
    { state: { lastRunStatus: "error", failureRetryAtMs: NOW + 30_000 } },
    "retrying",
  ],
  ["repair running", { state: { lastRunStatus: "error", failureRepair: repair } }, "repairing"],
  [
    "terminal one-shot repair running",
    {
      enabled: false,
      state: {
        failureRepair: repair,
        autoDisabled: { reason: "consecutive-failures", atMs: NOW, consecutiveErrors: 1 },
      },
    },
    "repairing",
  ],
  [
    "repair settled",
    { state: { failureRepair: { ...repair, settledAtMs: NOW - 1 } } },
    "verifying",
  ],
  [
    "repair deadline passed",
    { state: { failureRepair: { ...repair, deadlineAtMs: NOW } } },
    "verifying",
  ],
  [
    "escalated",
    { state: { failureRepair: { ...repair, settledAtMs: NOW - 5, escalatedAtMs: NOW - 1 } } },
    "needs-you",
  ],
  [
    "auto-disabled after escalation",
    {
      enabled: false,
      state: {
        failureRepair: { ...repair, escalatedAtMs: NOW - 1 },
        autoDisabled: { reason: "consecutive-failures", atMs: NOW, consecutiveErrors: 10 },
      },
    },
    "disabled",
  ],
  ["operator pause", { enabled: false, state: { lastRunStatus: "error" } }, undefined],
])("resolves the failure phase: %s", (_name, overrides, phase) => {
  expect(resolveCronFailurePhase(createJob("job", overrides), NOW)).toBe(phase);
});

it("leads with what happens next and keeps the raw error behind a disclosure", async () => {
  const rawError =
    'cron trigger evaluation failed (internal_error): Error: {"status":403,"body":"forbidden"}';
  const job = createJob("repairing", {
    owner: { agentId: "main", sessionKey: "agent:main:main" },
    state: {
      lastRunStatus: "error",
      lastError: rawError,
      failureRepair: { startedAtMs: Date.now(), deadlineAtMs: Date.now() + 60_000 },
    },
  });
  const container = await renderView({ editingJob: job, onOpenConversation: () => {} });
  const banner = container.querySelector<HTMLElement>(".cron-failure-details");
  expect(banner?.dataset.phase).toBe("repairing");
  expect(banner?.classList.contains("info")).toBe(true);
  expect(banner?.textContent).toContain("Fixing a failed run");
  expect(banner?.textContent).toContain("Your agent is looking into it.");
  expect(banner?.querySelector('[data-test-id="cron-open-conversation"]')).not.toBeNull();
  const details = banner?.querySelector("details.cron-error-details");
  expect(details?.hasAttribute("open")).toBe(false);
  expect(details?.textContent).toContain(rawError);
  // The error appears exactly once: inside the collapsed details.
  expect(banner?.textContent?.split(rawError)).toHaveLength(2);
});

it("asks for the user after a failed fix attempt and offers to run again", async () => {
  const job = createJob("needs-you", {
    owner: { agentId: "main", sessionKey: "agent:main:main" },
    state: {
      lastRunStatus: "error",
      nextRunAtMs: Date.UTC(2026, 10, 22, 9),
      lastError: `Provider rejected the request. ${"x".repeat(300)}`,
      failureRepair: { startedAtMs: 1, deadlineAtMs: 2, settledAtMs: 2, escalatedAtMs: 3 },
    },
  });
  const container = await renderView({ editingJob: job, onOpenConversation: () => {} });
  const banner = container.querySelector<HTMLElement>(".cron-failure-details");
  expect(banner?.classList.contains("danger")).toBe(true);
  expect(banner?.textContent).toContain("Still failing after an automatic fix attempt. Next run");
  expect(banner?.querySelector('[data-test-id="cron-attention-run-now"]')).not.toBeNull();
  const preview = banner?.querySelector(".cron-failure-details__cause")?.textContent ?? "";
  expect(preview.startsWith("Provider rejected the request.")).toBe(true);
  expect(preview.length).toBeLessThanOrEqual(140);
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
