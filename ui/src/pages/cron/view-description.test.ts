import { getByRole } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { createInitialCronState, startCronEdit } from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { attribute, inputValue, text } from "./cron-assertions.test-support.ts";
import {
  createCronViewJob,
  getElement,
  openCronMenu,
  renderCronView,
} from "./view.test-support.ts";

it.each([
  { displayName: "Morning health report", expected: "Morning health report", enabled: true },
  { displayName: undefined, expected: "cron:ops:weekday-health", enabled: false },
])(
  "uses saved label $expected (enabled=$enabled) without replacing action or editor identity",
  async ({ displayName, expected, enabled }) => {
    const onSelectJob = vi.fn();
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const job = createCronViewJob("display-name-job", {
      name: "cron:ops:weekday-health",
      configRevision: "fixture-config-revision",
      enabled,
      ...(displayName === undefined ? {} : { displayName }),
    });
    const row = await renderCronView({ jobs: [job], onSelectJob, onRun, onToggle });
    const name = row.querySelector<HTMLSpanElement>(".cron-table__name-text");
    expect(name?.textContent).toBe(expected);
    for (const selector of [".cron-row-run", ".cron-job-menu__trigger"]) {
      expect(attribute(row, selector, "aria-label")).toContain(expected);
    }
    expect(row.querySelectorAll('.cron-job-menu [role="menuitem"]')).toHaveLength(0);
    const toggle = getElement(row, `[data-test-id="cron-row-toggle-${job.id}"]`, HTMLSpanElement);
    const toggleInput = getElement(toggle, "input.settings-toggle__input", HTMLInputElement);
    const actionLabel = `${enabled ? "Pause" : "Resume"}: ${expected}`;
    expect(getByRole(toggle, "switch", { name: actionLabel })).toBe(toggleInput);
    expect(toggle).toMatchObject({ title: actionLabel });
    expect(toggleInput.checked).toBe(enabled);

    getElement(row, ".cron-row-run", HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledExactlyOnceWith(job, "force");
    toggleInput.checked = !enabled;
    toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledExactlyOnceWith(job, !enabled);
    await openCronMenu(row, ".cron-job-menu");
    expect(row.querySelectorAll('.cron-job-menu [role="menuitem"]')).toHaveLength(3);
    getElement(row, '.cron-job-menu [data-value="run-if-due"]', HTMLButtonElement).click();
    await waitForSolid(() => expect(onRun).toHaveBeenLastCalledWith(job, "due"));
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onSelectJob).not.toHaveBeenCalled();
    name?.click();
    expect(onSelectJob).toHaveBeenCalledExactlyOnceWith(job);
    expect(job.enabled).toBe(enabled);

    const state = createInitialCronState();
    startCronEdit(state, job);
    expect(state.cronEditingJob).toEqual(job);
    expect(state.cronForm.name).toBe("cron:ops:weekday-health");
    const detail = await renderCronView({
      editingJob: state.cronEditingJob,
      form: { ...state.cronForm, name: "Unsaved stable name" },
      onRun,
    });
    expect(text(detail, ".cron-detail-title")).toBe(expected);
    expect(inputValue(detail, "#cron-name")).toBe("Unsaved stable name");
    await openCronMenu(detail, ".cron-detail-actions .cron-job-menu");
    const detailDue = getElement(
      detail,
      '.cron-detail-actions [data-value="run-if-due"]',
      HTMLButtonElement,
    );
    expect(document.activeElement).toBe(detailDue);
    detailDue.click();
    await waitForSolid(() => expect(onRun).toHaveBeenCalledTimes(3));
    expect(onRun).toHaveBeenLastCalledWith(job, "due");

    expect(job.name).toBe("cron:ops:weekday-health");
    expect(job.displayName).toBe(displayName);
  },
);

it("uses the saved description for row selection and detail instead of unsaved edits", async () => {
  const onSelectJob = vi.fn();
  const job = createCronViewJob("described-job", {
    description: "  Summarize overnight deployment activity  ",
  });
  const container = await renderCronView({ jobs: [job], onSelectJob });
  const description = getElement(
    container,
    `[data-test-id="cron-row-description-${job.id}"]`,
    HTMLSpanElement,
  );
  expect([description.textContent?.trim(), description.title]).toEqual([
    "Summarize overnight deployment activity",
    "Description: Summarize overnight deployment activity",
  ]);
  description.click();
  expect(onSelectJob).toHaveBeenCalledWith(job);
  const detail = await renderCronView({
    editingJob: job,
    form: { ...DEFAULT_CRON_FORM, description: "Unsaved description edit" },
  });
  const saved = getElement(detail, '[data-test-id="cron-detail-description"]', HTMLDivElement);
  expect(saved.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "Description: Summarize overnight deployment activity",
  );
  expect(saved.textContent).not.toContain("Unsaved description edit");
});

it("renders saved descriptions as escaped text", async () => {
  const description = '<img src="x" onerror="alert(1)"> & <script>alert(1)</script>';
  const job = createCronViewJob("escaped-description", { description, displayName: description });
  const container = await renderCronView({ jobs: [job] });

  expect(text(container, ".cron-table__name-text")).toBe(description);
  expect(text(container, ".cron-table__description")).toContain(description);
  expect(
    container.querySelectorAll(".cron-table__name img, .cron-table__name script"),
  ).toHaveLength(0);
});
