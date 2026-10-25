import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { CronProps } from "./view-types.ts";
import { createCronViewJob, createCronViewProps, getElement } from "./view.test-support.ts";
import { CronView } from "./view.tsx";

function mountView(overrides: Partial<CronProps> = {}) {
  const [props, setProps] = createSignal(createCronViewProps(overrides));
  const view = mountSolid(() => <CronView {...props()} />);
  const patch = (changes: Partial<CronProps>) => {
    setProps((previous) => ({ ...previous, ...changes }));
    flush();
  };
  return { view, patch };
}

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
  const { view, patch } = mountView({ jobs: [job], jobsTotal: 1 });
  const row = view.container.querySelector('[data-test-id="cron-row-job-update"]');
  patch({ jobs: [{ ...job, enabled: false, description: "Paused until tomorrow" }] });
  expect(view.container.querySelector('[data-test-id="cron-row-job-update"]')).toBe(row);
  expect(row?.textContent).toContain("Paused until tomorrow");
  expect(row?.querySelector(".cron-table__state--paused")?.getAttribute("aria-label")).toBe(
    "Paused",
  );
});

it("does not reread retained jobs while typing and still dispatches current row actions", () => {
  const job = createCronViewJob("retained");
  const state = job.state;
  const readState = vi.fn(() => state);
  Object.defineProperty(job, "state", { get: readState });
  const { view, patch } = mountView({ jobs: [job, createCronViewJob("sibling")], jobsTotal: 2 });
  const row = view.container.querySelector<HTMLElement>('[data-test-id="cron-row-retained"]')!;
  const onSelectJob = vi.fn();
  readState.mockClear();
  patch({ jobsQuery: "daily", loading: true, onSelectJob });
  expect(readState).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-test-id="cron-row-retained"]')).toBe(row);
  row.click();
  expect(onSelectJob).toHaveBeenCalledExactlyOnceWith(job);
});

it("publishes refreshed runtime facts from the mutable selected job", async () => {
  const job = createCronViewJob("job-runtime", {
    trigger: { script: "json({ fire: false })" },
    state: { triggerEvalCount: 1 },
  });
  const { view, patch } = mountView({ editingJob: job, detailTab: "history" });
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
  patch({});
  expect(counts()[0]).toBe("2");
});

it("keeps pagination current while a query is pending without mounting editor suggestions", () => {
  const onLoadMoreJobs = vi.fn();
  const { view, patch } = mountView({
    jobs: [createCronViewJob("first"), createCronViewJob("second")],
    jobsTotal: 12,
    jobsHasMore: true,
    onLoadMoreJobs,
    timezoneSuggestions: ["UTC", "Europe/Vienna"],
  });
  const button = getElement(view.container, ".cron-load-more", HTMLButtonElement);
  expect(view.container.querySelector("datalist")).toBeNull();
  expect(view.container.querySelector(".cron-table__footer")?.textContent).toContain("2 of 12");
  button.click();
  expect(onLoadMoreJobs).toHaveBeenCalledOnce();
  patch({
    jobsQuery: "i",
    loading: true,
    jobsLoadingMore: true,
    timezoneSuggestions: ["UTC", "Europe/Vienna"],
  });
  expect(view.container.querySelector(".cron-load-more")).toBe(button);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Loading");
  expect(view.container.querySelector("datalist")).toBeNull();
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
  patch({ timezoneSuggestions: ["Europe/Vienna", "Asia/Tokyo"] });
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
    runAtMs: 1,
    jobId: "job-stable",
    action: "finished" as const,
    status: "ok" as const,
    summary: "First summary",
  };
  const { view, patch } = mountView({ listTab: "activity", runs: [first], onViewRunTranscript });
  const button = getElement(view.container, ".cron-run-entry button", HTMLButtonElement);
  const option = getElement(
    view.container,
    '[data-filter="status"] [data-value="option:ok"]',
    HTMLButtonElement,
  );
  const refreshed = { ...first, summary: "Updated summary" };
  patch({ runs: [refreshed], runsStatuses: ["ok"] });
  expect(view.container.querySelector(".cron-run-entry button")).toBe(button);
  expect(view.container.querySelector('[data-filter="status"] [data-value="option:ok"]')).toBe(
    option,
  );
  expect(option.getAttribute("aria-checked")).toBe("true");
  expect(view.container.querySelector(".cron-run-entry__body")?.textContent).toContain(
    "Updated summary",
  );
  button.click();
  expect(onViewRunTranscript).toHaveBeenCalledExactlyOnceWith(refreshed, button);
});

it("keeps retained row controls current across pending queries and access changes", () => {
  const job = createCronViewJob("retained-actions");
  const initialRun = vi.fn();
  const currentRun = vi.fn();
  const { view, patch } = mountView({ jobs: [job], jobsTotal: 1, onRun: initialRun });
  const row = getElement(view.container, ".cron-table__row", HTMLDivElement);
  const run = getElement(row, ".cron-row-run", HTMLButtonElement);
  const toggle = getElement(row, "input.settings-toggle__input", HTMLInputElement);

  patch({ jobsQuery: "retained", loading: true, busy: true });
  expect(view.container.querySelector(".cron-table__row")).toBe(row);
  expect(run.disabled).toBe(true);
  expect(toggle.disabled).toBe(true);

  patch({ toggleSavingJobId: job.id });
  expect(run.disabled).toBe(true);
  expect(toggle.disabled).toBe(false);
  expect(toggle.getAttribute("aria-disabled")).toBe("true");

  patch({ connected: false });
  expect(run.disabled).toBe(true);
  expect(toggle.disabled).toBe(true);

  patch({
    busy: false,
    connected: true,
    toggleSavingJobId: null,
    onRun: currentRun,
  });
  expect(row.querySelector(".cron-row-run")).toBe(run);
  expect(run.disabled).toBe(false);
  expect(toggle.getAttribute("aria-disabled")).toBeNull();
  run.click();
  expect(currentRun).toHaveBeenCalledExactlyOnceWith(job, "force");
  expect(initialRun).not.toHaveBeenCalled();

  patch({ canManage: false });
  expect(view.container.querySelector(".cron-table__row")).toBe(row);
  expect(row.querySelector(".cron-table__actions")).toBeNull();
});
