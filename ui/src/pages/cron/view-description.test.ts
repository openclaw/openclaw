import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createInitialCronState, startCronEdit } from "../../lib/cron/index.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { createCronViewJob, getElement, renderCronView } from "./view.test-support.ts";

const payloadCases = [
  { kind: "systemEvent", payload: { kind: "systemEvent", text: "check status" } },
  { kind: "agentTurn", payload: { kind: "agentTurn", message: "Summarize updates" } },
  { kind: "command", payload: { kind: "command", argv: ["echo", "ready"] } },
  { kind: "script", payload: { kind: "script", script: "return 'ready'" } },
  { kind: "heartbeat", payload: { kind: "heartbeat" } },
] satisfies Array<{ kind: CronJob["payload"]["kind"]; payload: CronJob["payload"] }>;

describe("cron view saved metadata", () => {
  it.each([
    { displayName: "Morning health report", expected: "Morning health report", enabled: true },
    { displayName: "Morning health report", expected: "Morning health report", enabled: false },
    { displayName: undefined, expected: "cron:ops:weekday-health", enabled: false },
  ])(
    "uses saved label $expected (enabled=$enabled) without replacing action or editor identity",
    ({ displayName, expected, enabled }) => {
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
      const toggleInput = getElement(toggle, "wa-switch", HTMLElement) as HTMLElement & {
        checked: boolean;
      };
      const actionLabel = `${enabled ? "Pause" : "Resume"}: ${expected}`;
      expect(toggleInput.querySelector(".settings-control__sr-label")?.textContent).toBe(
        actionLabel,
      );
      expect(toggle.title).toBe(actionLabel);
      expect(toggleInput.checked).toBe(enabled);

      getElement(row, ".cron-row-run", HTMLButtonElement).click();
      expect(onRun).toHaveBeenCalledExactlyOnceWith(job, "force");
      toggleInput.checked = !enabled;
      toggleInput.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onToggle).toHaveBeenCalledExactlyOnceWith(job, !enabled);
      const dueItem = getElement(row, 'wa-dropdown-item[value="run-if-due"]', HTMLElement);
      getElement(row, "wa-dropdown", HTMLElement).dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: dueItem }, bubbles: true }),
      );
      expect(onRun).toHaveBeenLastCalledWith(job, "due");
      expect(onRun).toHaveBeenCalledTimes(2);
      expect(onSelectJob).not.toHaveBeenCalled();
      name?.click();
      expect(onSelectJob).toHaveBeenCalledExactlyOnceWith(job);
      expect(job.enabled).toBe(enabled);

      const state = createInitialCronState();
      startCronEdit(state, job);
      expect(state.cronEditingJobId).toBe(job.id);
      expect(state.cronEditingConfigRevision).toBe(job.configRevision);
      const detail = renderCronView({ editingJob: state.cronEditingJob, form: state.cronForm });
      expect(detail.querySelector(".cron-detail-title")?.textContent).toBe(expected);
      expect(detail.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
        "cron:ops:weekday-health",
      );

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

  it.each(payloadCases)(
    "shows the saved description inline for $kind tasks without changing row selection",
    ({ kind, payload }) => {
      const onSelectJob = vi.fn();
      const job = createCronViewJob(`described-${kind}`, {
        description: "  Summarize overnight deployment activity  ",
        payload,
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
    },
  );

  it.each([undefined, "", "  \n\t  "])(
    "omits the inline description when the saved description is %j",
    (description) => {
      const job = createCronViewJob("without-description", { description });
      const container = renderCronView({ jobs: [job] });

      expect(container.querySelector(".cron-table__description")).toBeNull();
    },
  );

  it("renders saved descriptions as escaped text", () => {
    const description = '<img src="x" onerror="alert(1)"> & <script>alert(1)</script>';
    const job = createCronViewJob("escaped-description", { description, displayName: description });
    const container = renderCronView({ jobs: [job] });

    expect(container.querySelector(".cron-table__name-text")?.textContent).toBe(description);
    expect(container.querySelector(".cron-table__description")?.textContent).toContain(description);
    expect(container.querySelector(".cron-table__name img")).toBeNull();
    expect(container.querySelector(".cron-table__name script")).toBeNull();
  });

  it.each(payloadCases)(
    "shows the saved $kind task description instead of unsaved form edits",
    ({ kind, payload }) => {
      const job = createCronViewJob(`saved-${kind}`, {
        description: "  Saved description for the selected task  ",
        payload,
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
    },
  );

  it.each([undefined, "", "  \n\t  "])(
    "omits the detail description when the saved description is %j",
    (description) => {
      const job = createCronViewJob("without-description", { description });
      const container = renderCronView({ jobs: [], editingJob: job });

      expect(container.querySelector('[data-test-id="cron-detail-description"]')).toBeNull();
    },
  );
});
