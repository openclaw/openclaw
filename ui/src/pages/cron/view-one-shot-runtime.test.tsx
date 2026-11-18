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

it("notes a one-shot's runtime only while it differs from the configured occurrence", async () => {
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
  const note = '[data-test-id="cron-schedule-note"]';
  await waitForSolid(() => expect(container.querySelector(note)).not.toBeNull());
  const summary = () => container.querySelector(note)?.textContent ?? null;
  const refresh = () => {
    setProps((previous) => ({ ...previous }));
    flush();
  };
  expect(summary()).toBe(`Next activity at ${formatMs(next)}`);
  const input = container.querySelector<HTMLInputElement>("#cron-schedule-at")!;
  expect(input.value).toBe(formatDateTimeLocal(at));
  for (const [state, enabled, expected] of [
    [{ nextRunAtMs: next + 60_000 }, true, `Next activity at ${formatMs(next + 60_000)}`],
    [{ nextRunAtMs: next, runningAtMs: next }, true, "Running"],
    [{ nextRunAtMs: next }, false, "Paused"],
    // The time field already says when it runs.
    [{ nextRunAtMs: Date.parse(at) }, true, null],
    [{}, true, "No next run scheduled"],
  ] as const) {
    job.state = state;
    job.enabled = enabled;
    refresh();
    expect(summary()).toBe(expected);
    expect(container.querySelector("#cron-schedule-at")).toBe(input);
    expect(input.value).toBe(formatDateTimeLocal(at));
  }
  const draft = formatDateTimeLocal("2026-11-01T12:00:00Z");
  setProps((previous) => ({ ...previous, form: { ...previous.form, scheduleAt: draft } }));
  flush();
  expect(summary()).toBeNull();
});
