import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createCronViewJob, createCronViewProps, getElement } from "./view.test-support.ts";
import { CronView } from "./view.tsx";

it("keeps the edited input and focus while its form and validation update", async () => {
  const initial = createCronViewProps({ createOpen: true });
  const [props, setProps] = createSignal(initial);
  initial.onFormChange = (patch) =>
    setProps((previous) => ({
      ...previous,
      form: { ...previous.form, ...patch },
      fieldErrors: { name: "cron.errors.nameRequired" },
    }));
  const view = mountSolid(() => <CronView {...props()} />);
  await vi.dynamicImportSettled();
  await waitForSolid(() => expect(view.container.querySelector("#cron-name")).not.toBeNull());
  const input = getElement(view.container, "#cron-name", HTMLInputElement);
  input.focus();
  input.value = "Daily check";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(view.container.querySelector("#cron-name")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Daily check");
  expect(view.container.querySelector("#cron-error-name")?.textContent).toBeTruthy();
});

it("updates a keyed job row from a replacement owner snapshot", () => {
  const job = createCronViewJob("job-update");
  const [props, setProps] = createSignal(createCronViewProps({ jobs: [job], jobsTotal: 1 }));
  const view = mountSolid(() => <CronView {...props()} />);
  const row = view.container.querySelector('[data-test-id="cron-row-job-update"]');
  setProps((previous) => ({
    ...previous,
    jobs: [{ ...job, enabled: false, description: "Paused until tomorrow" }],
  }));
  flush();
  expect(view.container.querySelector('[data-test-id="cron-row-job-update"]')).toBe(row);
  expect(row?.textContent).toContain("Paused until tomorrow");
  expect(row?.querySelector(".cron-table__state--paused")?.getAttribute("aria-label")).toBe(
    "Paused",
  );
});

it("checks each retained row's permission once while typing and dispatches current actions", () => {
  const job = createCronViewJob("retained");
  const state = job.state;
  const readState = vi.fn(() => state);
  const canManageJob = vi.fn(() => true);
  Object.defineProperty(job, "state", { get: readState });
  const [props, setProps] = createSignal(
    createCronViewProps({
      jobs: [job, createCronViewJob("sibling")],
      jobsTotal: 2,
      canManageJob,
      canCreate: true,
    }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const row = view.container.querySelector<HTMLElement>('[data-test-id="cron-row-retained"]')!;
  const onSelectJob = vi.fn();
  readState.mockClear();
  canManageJob.mockClear();
  setProps((previous) => ({ ...previous, jobsQuery: "daily", loading: true, onSelectJob }));
  flush();
  expect(readState).not.toHaveBeenCalled();
  expect(canManageJob).toHaveBeenCalledTimes(2);
  expect(view.container.querySelector('[data-test-id="cron-row-retained"]')).toBe(row);
  row.click();
  expect(onSelectJob).toHaveBeenCalledExactlyOnceWith(job);
});

it("publishes refreshed runtime facts from the mutable selected job", async () => {
  const job = createCronViewJob("job-runtime", {
    trigger: { script: "json({ fire: false })" },
    state: { triggerEvalCount: 1 },
  });
  const [props, setProps] = createSignal(
    createCronViewProps({ editingJob: job, detailTab: "history" }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(view.container.querySelector(".cron-condition-activity dd")).not.toBeNull(),
  );
  const counts = () =>
    [...view.container.querySelectorAll(".cron-condition-activity dd")].map(
      (node) => node.textContent,
    );
  expect(counts()[0]).toBe("1");
  job.state = { triggerEvalCount: 2 };
  setProps((previous) => ({ ...previous }));
  flush();
  expect(counts()[0]).toBe("2");
});

it("keeps append loading local without a footer or mounting editor suggestions", () => {
  const [props, setProps] = createSignal(
    createCronViewProps({
      jobs: [createCronViewJob("first"), createCronViewJob("second")],
      jobsTotal: 12,
      jobsHasMore: true,
      timezoneSuggestions: ["UTC", "Europe/Vienna"],
    }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const row = view.container.querySelector(".cron-table__row");
  expect(view.container.querySelector("datalist")).toBeNull();
  expect(view.container.querySelector(".cron-table__footer")).toBeNull();
  expect(view.container.querySelector(".cron-load-more")).toBeNull();
  setProps((previous) => ({ ...previous, jobsLoadingMore: true }));
  flush();
  const loading = getElement(
    view.container,
    '[data-test-id="cron-jobs-loading-more"]',
    HTMLElement,
  );
  expect(loading.getAttribute("role")).toBe("status");
  expect(view.container.querySelector(".cron-table__row")).toBe(row);
  expect(view.container.querySelector("datalist")).toBeNull();
  setProps((previous) => ({ ...previous, jobsLoadingMore: false, listError: "Page unavailable" }));
  flush();
  expect(view.container.querySelector('[data-test-id="cron-jobs-loading-more"]')).toBeNull();
  expect(view.container.querySelector(".cron-table__row")).toBe(row);
});

it("retains live suggestions only while the editor is presented", async () => {
  const [props, setProps] = createSignal(
    createCronViewProps({ createOpen: true, timezoneSuggestions: ["UTC", "Europe/Vienna"] }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  await vi.dynamicImportSettled();
  await waitForSolid(() =>
    expect(view.container.querySelector("#cron-tz-suggestions")).not.toBeNull(),
  );
  const timezones = getElement(view.container, "#cron-tz-suggestions", HTMLDataListElement);
  const options = [...timezones.querySelectorAll("option")];
  expect(options.map((option) => option.value)).toEqual(["UTC", "Europe/Vienna"]);
  setProps((previous) => ({ ...previous, timezoneSuggestions: [...previous.timezoneSuggestions] }));
  flush();
  expect(view.container.querySelector("#cron-tz-suggestions")).toBe(timezones);
  expect(timezones.querySelectorAll("option")[0]).toBe(options[0]);
  expect(timezones.querySelectorAll("option")[1]).toBe(options[1]);
  setProps((previous) => ({ ...previous, timezoneSuggestions: ["Europe/Vienna", "Asia/Tokyo"] }));
  flush();
  expect(view.container.querySelector("#cron-tz-suggestions")).toBe(timezones);
  expect([...timezones.querySelectorAll("option")].map((option) => option.value)).toEqual([
    "Europe/Vienna",
    "Asia/Tokyo",
  ]);
  setProps((previous) => ({ ...previous, createOpen: false }));
  flush();
  expect(view.container.querySelector("datalist")).toBeNull();
});

it("retains history controls and forwards the current transcript target after refresh", () => {
  const onViewRunTranscript = vi.fn();
  const first = {
    ts: 1,
    runId: "run-stable",
    runAtMs: Date.now() - 60_000,
    durationMs: 2_000,
    nextRunAtMs: Date.now() + 60_000,
    jobId: "job-stable",
    action: "finished" as const,
    status: "ok" as const,
    summary: "First summary",
  };
  const [props, setProps] = createSignal(
    createCronViewProps({
      listTab: "activity",
      jobs: [createCronViewJob("job-stable", { agentId: "garden" })],
      runs: [first],
      onViewRunTranscript,
    }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const button = getElement(
    view.container,
    '.cron-run-entry [aria-label="View transcript"]',
    HTMLButtonElement,
  );
  const option = getElement(
    view.container,
    '[data-filter="status"] [data-value="option:ok"]',
    HTMLButtonElement,
  );
  const compact = getElement(view.container, ".cron-run-entry--compact", HTMLElement);
  expect(compact.querySelector(".cron-run-status")?.getAttribute("aria-label")).toBe("Completed");
  expect(compact.querySelector(".cron-run-entry__secondary")?.textContent).toMatch(
    /garden.*ago.*2s/,
  );
  expect(compact.querySelector(".cron-run-entry__time")).not.toBeNull();
  expect(compact.querySelector(".cron-run-entry__meta")).toBeNull();
  expect(compact.querySelector(".cron-run-entry__body")).toBeNull();
  const refreshed = { ...first, summary: "Updated summary" };
  setProps((previous) => ({ ...previous, runs: [refreshed], runsStatuses: ["ok"] }));
  flush();
  expect(view.container.querySelector('.cron-run-entry [aria-label="View transcript"]')).toBe(
    button,
  );
  expect(view.container.querySelector('[data-filter="status"] [data-value="option:ok"]')).toBe(
    option,
  );
  expect(option.getAttribute("aria-checked")).toBe("true");
  expect(view.container.querySelector(".cron-run-entry__summary")?.textContent).toContain(
    "Updated summary",
  );
  button.click();
  expect(onViewRunTranscript).toHaveBeenCalledExactlyOnceWith(refreshed, button);
});

it("keeps retained row controls current across pending queries and access changes", () => {
  const job = createCronViewJob("retained-actions");
  let canManage = true;
  const initialRun = vi.fn();
  const currentRun = vi.fn();
  const [props, setProps] = createSignal(
    createCronViewProps({
      jobs: [job],
      jobsTotal: 1,
      onRun: initialRun,
      canManageJob: () => canManage,
    }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const row = getElement(view.container, ".cron-table__row", HTMLDivElement);
  const run = getElement(row, ".cron-row-run", HTMLButtonElement);
  const toggle = getElement(row, "input.settings-toggle__input", HTMLInputElement);

  setProps((previous) => ({ ...previous, jobsQuery: "retained", loading: true, busy: true }));
  flush();
  expect(view.container.querySelector(".cron-table__row")).toBe(row);
  expect(run.disabled).toBe(true);
  expect(toggle.disabled).toBe(true);

  setProps((previous) => ({ ...previous, toggleSavingJobId: job.id }));
  flush();
  expect(run.disabled).toBe(true);
  expect(toggle.disabled).toBe(false);
  expect(toggle.getAttribute("aria-disabled")).toBe("true");

  setProps((previous) => ({ ...previous, connected: false }));
  flush();
  expect(run.disabled).toBe(true);
  expect(toggle.disabled).toBe(true);

  setProps((previous) => ({
    ...previous,
    busy: false,
    connected: true,
    toggleSavingJobId: null,
    onRun: currentRun,
  }));
  flush();
  expect(row.querySelector(".cron-row-run")).toBe(run);
  expect(run.disabled).toBe(false);
  expect(toggle.getAttribute("aria-disabled")).toBeNull();
  run.click();
  expect(currentRun).toHaveBeenCalledExactlyOnceWith(job, "force");
  expect(initialRun).not.toHaveBeenCalled();

  canManage = false;
  setProps((previous) => ({ ...previous }));
  flush();
  expect(view.container.querySelector(".cron-table__row")).toBe(row);
  expect(row.querySelector(".cron-table__actions")).toBeNull();
});

it("keeps the phone run's recorded next run as a fixed time", () => {
  const run = {
    ts: 1,
    runId: "run-next",
    runAtMs: 1,
    jobId: "job-next",
    action: "finished" as const,
    status: "ok" as const,
    summary: "Done",
    nextRunAtMs: Date.UTC(2020, 5, 15, 12, 0),
  };
  const view = mountSolid(() => (
    <CronView {...createCronViewProps({ phoneLayout: true, listTab: "activity", runs: [run] })} />
  ));
  const label = getElement(view.container, ".cron-run-entry__meta", HTMLElement).textContent;
  expect(label).toMatch(/Next .*2020/);
  expect(label).not.toMatch(/Due|ago/);
});
