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
  const input = getElement(view.container, "#cron-name", HTMLTextAreaElement);
  input.focus();
  input.value = "Daily check";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(view.container.querySelector("#cron-name")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Daily check");
  expect(view.container.querySelector("#cron-error-name")?.textContent).toBeTruthy();
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

it("retains activity history and filters without transcript controls after refresh", () => {
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
    createCronViewProps({ activityOpen: true, runs: [first] }),
  );
  const view = mountSolid(() => <CronView {...props()} />);
  const row = getElement(view.container, ".cron-run-entry", HTMLDivElement);
  expect(row.textContent).toContain("First summary");
  expect(row.textContent).not.toContain("View transcript");
  const option = getElement(
    view.container,
    '[data-filter="status"] [data-value="option:ok"]',
    HTMLButtonElement,
  );
  const refreshed = { ...first, summary: "Updated summary" };
  setProps((previous) => ({ ...previous, runs: [refreshed], runsStatuses: ["ok"] }));
  flush();
  expect(view.container.querySelector(".cron-run-entry")).toBe(row);
  expect(row.textContent).not.toContain("View transcript");
  expect(view.container.querySelector('[data-filter="status"] [data-value="option:ok"]')).toBe(
    option,
  );
  expect(option.getAttribute("aria-checked")).toBe("true");
  expect(view.container.querySelector(".cron-run-entry__body")?.textContent).toContain(
    "Updated summary",
  );
});

it("shows a run's recorded next run as a fixed time, not a live relative label", () => {
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
    <CronView {...createCronViewProps({ activityOpen: true, runs: [run] })} />
  ));
  const label = getElement(view.container, ".cron-run-entry__meta", HTMLElement).textContent;
  expect(label).toMatch(/Next .*2020/);
  expect(label).not.toMatch(/Due|ago/);
});
