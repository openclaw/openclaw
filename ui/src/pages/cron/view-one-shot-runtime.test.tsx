import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { formatDateTimeLocal } from "../../lib/cron/form-schedule.ts";
import { jobToForm } from "../../lib/cron/form.ts";
import { formatMs } from "../../lib/format.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createCronViewJob, createCronViewProps } from "./view.test-support.ts";
import { CronView } from "./view.tsx";

it("keeps the configured occurrence while runtime refreshes, pauses, runs, or completes", async () => {
  const at = "2026-10-30T12:00:56.789Z";
  const next = Date.parse("2026-10-30T12:10:00Z");
  const job = createCronViewJob("continuation", {
    schedule: { kind: "at", at },
    state: { nextRunAtMs: next },
  });
  const [props, setProps] = createSignal(
    createCronViewProps({ editingJob: job, form: jobToForm(job, DEFAULT_CRON_FORM) }),
  );
  const { container } = mountSolid(() => <CronView {...props()} />);
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(container.querySelector(".cron-schedule-summary")).not.toBeNull(),
  );
  const summary = () => container.querySelector(".cron-schedule-summary")?.textContent;
  const refresh = () => {
    setProps((previous) => ({ ...previous }));
    flush();
  };
  expect(summary()).toContain(`Next run at ${formatMs(next)}`);
  const input = container.querySelector<HTMLInputElement>("#cron-schedule-at")!;
  expect(input.value).toBe(formatDateTimeLocal(at));
  for (const [state, enabled, expected] of [
    [{ nextRunAtMs: next + 60_000 }, true, `Next run at ${formatMs(next + 60_000)}`],
    [{ nextRunAtMs: next, runningAtMs: next }, true, "Running"],
    [{ nextRunAtMs: next }, false, "Paused"],
    [{}, true, "No next run scheduled"],
  ] as const) {
    job.state = state;
    job.enabled = enabled;
    refresh();
    expect(summary()).toContain(expected);
    expect(container.querySelector(".cron-detail-meta > .cron-detail-sub")?.textContent).toContain(
      expected.startsWith("Next run at") ? "Next " : expected,
    );
    expect(container.querySelector("#cron-schedule-at")).toBe(input);
    expect(input.value).toBe(formatDateTimeLocal(at));
  }
  const draft = formatDateTimeLocal("2026-11-01T12:00:00Z");
  setProps((previous) => ({ ...previous, form: { ...previous.form, scheduleAt: draft } }));
  flush();
  expect(summary()).toContain("Runs once at");
  expect(summary()).not.toContain("No next run scheduled");
});
