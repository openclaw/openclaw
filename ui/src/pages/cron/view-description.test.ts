import { expect, it, vi } from "vitest";
import { createInitialCronState, startCronEdit } from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { inputValue, text } from "./cron-assertions.test-support.ts";
import { createCronViewJob, getElement, renderCronView } from "./view.test-support.ts";

it.each([
  { displayName: "Morning health report", expected: "Morning health report", enabled: true },
  { displayName: undefined, expected: "cron:ops:weekday-health", enabled: false },
])(
  "uses saved label $expected (enabled=$enabled) without replacing action or editor identity",
  async ({ displayName, expected, enabled }) => {
    const onRun = vi.fn();
    const job = createCronViewJob("display-name-job", {
      name: "cron:ops:weekday-health",
      configRevision: "fixture-config-revision",
      enabled,
      ...(displayName === undefined ? {} : { displayName }),
    });
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
    getElement(detail, '[data-test-id="cron-run-now"]', HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledExactlyOnceWith(job);

    expect(job.name).toBe("cron:ops:weekday-health");
    expect(job.displayName).toBe(displayName);
  },
);

it("uses the saved description for the detail instead of unsaved edits", async () => {
  const job = createCronViewJob("described-job", {
    description: "  Summarize overnight deployment activity  ",
  });
  const detail = await renderCronView({
    editingJob: job,
    form: { ...DEFAULT_CRON_FORM, description: "Unsaved description edit" },
  });
  const saved = getElement(detail, '[data-test-id="cron-detail-description"]', HTMLDivElement);
  expect(saved.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "Summarize overnight deployment activity",
  );
  expect(saved.textContent).not.toContain("Unsaved description edit");
});

it("renders saved descriptions as escaped text", async () => {
  const description = '<img src="x" onerror="alert(1)"> & <script>alert(1)</script>';
  const job = createCronViewJob("escaped-description", { description, displayName: description });
  const container = await renderCronView({ editingJob: job });

  expect(text(container, ".cron-detail-title")).toBe(description);
  expect(text(container, '[data-test-id="cron-detail-description"]')).toContain(description);
  expect(
    container.querySelectorAll(".cron-detail-header img, .cron-detail-header script"),
  ).toHaveLength(0);
});
