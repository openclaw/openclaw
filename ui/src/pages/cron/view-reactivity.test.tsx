import WaDropdownItem from "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createCronViewJob, createCronViewProps, getElement } from "./view.test-support.ts";
import { CronView } from "./view.tsx";

it("keeps the edited input and focus while its form and validation update", () => {
  const initial = createCronViewProps({ createOpen: true });
  const [props, setProps] = createSignal(initial);
  initial.onFormChange = (patch) =>
    setProps((previous) => ({
      ...previous,
      form: { ...previous.form, ...patch },
      fieldErrors: { name: "cron.errors.nameRequired" },
    }));
  const view = mountSolid(() => <CronView {...props()} />);
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

it("publishes refreshed runtime facts from the mutable selected job", () => {
  const job = createCronViewJob("job-runtime", {
    trigger: { script: "json({ fire: false })" },
    state: { triggerEvalCount: 1 },
  });
  const [props, setProps] = createSignal(
    createCronViewProps({ editingJob: job, detailTab: "history" }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
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

it("keeps the pagination count and load action current while the next page is pending", () => {
  const onLoadMoreJobs = vi.fn();
  const [props, setProps] = createSignal(
    createCronViewProps({
      jobs: [createCronViewJob("first"), createCronViewJob("second")],
      jobsTotal: 12,
      jobsHasMore: true,
      onLoadMoreJobs,
    }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const button = getElement(view.container, ".cron-load-more", HTMLButtonElement);
  expect(view.container.querySelector(".cron-table__footer")?.textContent).toContain("2 of 12");
  button.click();
  expect(onLoadMoreJobs).toHaveBeenCalledOnce();
  setProps((previous) => ({ ...previous, jobsLoadingMore: true }));
  flush();
  expect(view.container.querySelector(".cron-load-more")).toBe(button);
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("Loading");
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
  const [props, setProps] = createSignal(
    createCronViewProps({ listTab: "activity", runs: [first], onViewRunTranscript }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const button = getElement(view.container, ".cron-run-entry button", HTMLButtonElement);
  const option = getElement(
    view.container,
    '[data-filter="status"] wa-dropdown-item[value="option:ok"]',
    WaDropdownItem,
  );
  const refreshed = { ...first, summary: "Updated summary" };
  setProps((previous) => ({ ...previous, runs: [refreshed], runsStatuses: ["ok"] }));
  flush();
  expect(view.container.querySelector(".cron-run-entry button")).toBe(button);
  expect(
    view.container.querySelector('[data-filter="status"] wa-dropdown-item[value="option:ok"]'),
  ).toBe(option);
  expect(option.checked).toBe(true);
  expect(view.container.querySelector(".cron-run-entry__body")?.textContent).toContain(
    "Updated summary",
  );
  button.click();
  expect(onViewRunTranscript).toHaveBeenCalledExactlyOnceWith(refreshed, button);
});
