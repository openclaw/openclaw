import { describe, expect, it, vi } from "vitest";
import { createInitialCronState, startCronEdit } from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createCronViewJob,
  getElement,
  openCronMenu,
  renderCronView,
} from "./view.test-support.ts";

describe("cron view saved metadata", () => {
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
      const row = renderCronView({ jobs: [job], onSelectJob, onRun, onToggle });
      const name = row.querySelector<HTMLSpanElement>(".cron-table__name-text");
      expect(name?.textContent).toBe(expected);
      expect(row.querySelector(".cron-row-run")?.getAttribute("aria-label")).toContain(expected);
      expect(row.querySelector(".cron-job-menu__trigger")?.getAttribute("aria-label")).toContain(
        expected,
      );
      const toggle = getElement(row, `[data-test-id="cron-row-toggle-${job.id}"]`, HTMLSpanElement);
      const toggleInput = getElement(toggle, "input.settings-toggle__input", HTMLInputElement);
      const actionLabel = `${enabled ? "Pause" : "Resume"}: ${expected}`;
      expect(toggle.querySelector(".settings-control__sr-label")?.textContent).toBe(actionLabel);
      expect(toggle.title).toBe(actionLabel);
      expect(toggleInput.checked).toBe(enabled);

      getElement(row, ".cron-row-run", HTMLButtonElement).click();
      expect(onRun).toHaveBeenCalledExactlyOnceWith(job, "force");
      toggleInput.checked = !enabled;
      toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onToggle).toHaveBeenCalledExactlyOnceWith(job, !enabled);
      await openCronMenu(row, ".cron-job-menu");
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
      const detail = renderCronView({
        editingJob: state.cronEditingJob,
        form: state.cronForm,
        onRun,
      });
      expect(detail.querySelector(".cron-detail-title")?.textContent).toBe(expected);
      expect(detail.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
        "cron:ops:weekday-health",
      );
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

      const draft = renderCronView({
        editingJob: state.cronEditingJob,
        form: { ...state.cronForm, name: "Unsaved stable name" },
      });
      expect(draft.querySelector(".cron-detail-title")?.textContent).toBe(expected);
      expect(draft.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
        "Unsaved stable name",
      );
      expect(job.name).toBe("cron:ops:weekday-health");
      expect(job.displayName).toBe(displayName);
    },
  );

  it("shows the saved description inline without changing row selection", () => {
    const onSelectJob = vi.fn();
    const job = createCronViewJob("described-job", {
      description: "  Summarize overnight deployment activity  ",
    });
    const container = renderCronView({ jobs: [job], onSelectJob });
    const description = container.querySelector<HTMLSpanElement>(
      `[data-test-id="cron-row-description-${job.id}"]`,
    );

    expect(description).toBeInstanceOf(HTMLSpanElement);
    expect(description?.textContent?.trim()).toBe("Summarize overnight deployment activity");
    expect(description?.title).toBe("Description: Summarize overnight deployment activity");
    description?.click();
    expect(onSelectJob).toHaveBeenCalledWith(job);
  });

  it("renders saved descriptions as escaped text", () => {
    const description = '<img src="x" onerror="alert(1)"> & <script>alert(1)</script>';
    const job = createCronViewJob("escaped-description", { description, displayName: description });
    const container = renderCronView({ jobs: [job] });

    expect(container.querySelector(".cron-table__name-text")?.textContent).toBe(description);
    expect(container.querySelector(".cron-table__description")?.textContent).toContain(description);
    expect(container.querySelector(".cron-table__name img")).toBeNull();
    expect(container.querySelector(".cron-table__name script")).toBeNull();
  });

  it("shows the saved task description instead of unsaved form edits", () => {
    const job = createCronViewJob("saved-job", {
      description: "  Saved description for the selected task  ",
    });
    const container = renderCronView({
      jobs: [],
      editingJob: job,
      form: { ...DEFAULT_CRON_FORM, description: "Unsaved description edit" },
    });
    const description = container.querySelector('[data-test-id="cron-detail-description"]');

    expect(description).toBeInstanceOf(HTMLDivElement);
    expect(description?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Description: Saved description for the selected task",
    );
    expect(description?.textContent).not.toContain("Unsaved description edit");
  });
});
