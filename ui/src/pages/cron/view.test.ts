import { describe, expect, it, vi } from "vitest";
import type { CronFormState } from "../../lib/cron/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { text, testId, attribute, fillInput } from "./cron-assertions.test-support.ts";
import type { CronProps } from "./view-types.ts";
import {
  createCronViewJob as createJob,
  findToggleByLabel,
  getButtonByText,
  getElement,
  openCronMenu,
  selectSegmented,
  renderCronView as renderView,
} from "./view.test-support.ts";

function renderEditor(form: Partial<CronFormState> = {}, props: Partial<CronProps> = {}) {
  return renderView({ ...props, createOpen: true, form: { ...DEFAULT_CRON_FORM, ...form } });
}

function picker(container: Element, id: string) {
  return getElement(container, `openclaw-select-picker:has(#${id})`, HTMLElement);
}

function selectSchedule(container: Element, kind: string) {
  selectSegmented(getElement(container, testId(`cron-schedule-kind-${kind}`), HTMLElement));
}

function optionValues(container: Element) {
  return Array.from(container.querySelectorAll('[role="option"]'), (option) =>
    option.getAttribute("data-value"),
  );
}

function expectAbsent(container: Element, ...selectors: string[]) {
  for (const selector of selectors) {
    expect(container.querySelector(selector), selector).toBeNull();
  }
}

async function chooseFocused(container: HTMLElement, value: string) {
  const trigger = getElement(container, ".picker-select__trigger", HTMLButtonElement);
  trigger.focus();
  await choosePickerValue(container, value);
  expect(container.querySelector(".picker-select__trigger")).toBe(trigger);
  expect(document.activeElement).toBe(trigger);
}

function expectInvalidField(container: Element, id: string, errorId: string, message: string) {
  const field = getElement(container, `#cron-${id}`, HTMLInputElement);
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(`cron-error-${errorId}`);
  expect(text(container, `#cron-error-${errorId}`)).toContain(message);
}

describe("cron view list pane", () => {
  it("combines status filters and run history in one tab row", () => {
    const onJobsFiltersChange = vi.fn();
    const onListTabChange = vi.fn();
    const container = renderView({
      jobsEnabledFilter: "enabled",
      onJobsFiltersChange,
      onListTabChange,
    });
    const labels = Array.from(container.querySelectorAll(".cron-list-hub-tabs .hub-tab"), (tab) =>
      tab.textContent?.trim(),
    );
    expect(labels).toEqual(["All", "Active", "Paused", "Run history"]);
    const active = getElement(container, testId("cron-tab-enabled"), HTMLElement);
    expect(active.getAttribute("aria-selected")).toBe("true");
    getElement(container, testId("cron-tab-disabled"), HTMLElement).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    expect(onListTabChange).toHaveBeenCalledWith("tasks");
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsEnabledFilter: "disabled" });
    getElement(container, testId("cron-list-tab-activity"), HTMLElement).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    expect(onListTabChange).toHaveBeenCalledWith("activity");
  });

  it("wires search and the advanced jobs filter popover", () => {
    const onJobsFiltersChange = vi.fn();
    const container = renderView({ onJobsFiltersChange });
    expect(fillInput(container, ".cron-search-box input", "brief")).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsQuery: "brief" });
    const scheduleFilter = getElement(
      container,
      testId("cron-jobs-schedule-filter"),
      HTMLSelectElement,
    );
    expect(Array.from(scheduleFilter.options, (option) => option.value)).toEqual([
      "all",
      "at",
      "every",
      "cron",
      "event",
      "on-exit",
      "stream",
    ]);
    for (const scheduleKind of ["on-exit", "stream", "event"] as const) {
      scheduleFilter.value = scheduleKind;
      scheduleFilter.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onJobsFiltersChange).toHaveBeenCalledWith({
        cronJobsScheduleKindFilter: scheduleKind,
      });
    }

    for (const [id, field, value] of [
      ["last-status", "cronJobsLastStatusFilter", "unknown"],
      ["trigger", "cronJobsTriggerFilter", "conditional"],
    ] as const) {
      const filter = getElement(container, testId(`cron-jobs-${id}-filter`), HTMLSelectElement);
      filter.value = value;
      filter.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onJobsFiltersChange).toHaveBeenCalledWith({ [field]: value });
    }
    const reset = getElement(container, testId("cron-jobs-filters-reset"), HTMLButtonElement);
    expect(reset.disabled).toBe(true);
  });

  it("renders table rows with independent native buttons for opening tasks", () => {
    const onSelectJob = vi.fn();
    const job = createJob("job-1", {
      trigger: { script: "json({ fire: true })" },
      state: { nextRunAtMs: Date.now() + 60_000 },
    });
    const paused = createJob("job-2", { name: "Paused task", enabled: false });
    const failed = createJob("job-3", {
      name: "Failing task",
      state: { lastRunStatus: "error", lastRunAtMs: Date.now() - 60_000 },
    });
    const container = renderView({ jobs: [job, paused, failed], onSelectJob });
    const rows = Array.from(container.querySelectorAll(".cron-table__row"));
    expect(rows).toHaveLength(3);
    for (const row of container.querySelectorAll('[role="row"]')) {
      expect(row.closest('[role="table"], [role="grid"], [role="treegrid"]')).not.toBeNull();
      expect(
        Array.from(row.children).every((child) =>
          child.matches(
            '[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]',
          ),
        ),
      ).toBe(true);
    }
    expect(rows[0]?.getAttribute("role")).toBeNull();
    expect(attribute(rows[0]!, ".cron-table__state--error", "aria-label")).toBe("Error");
    expect(rows[0]?.querySelector(".cron-last-glyph--error")).not.toBeNull();
    expect(attribute(rows[0]!, ".cron-table__last-run", "aria-label")).toBe("Error");
    expect(rows[1]?.textContent).toContain("Cron 0 9 * * *");
    expect(rows[1]?.querySelector(".cron-last-glyph--ok")).toBeNull();
    expect(rows[1]?.textContent).toContain("n/a");
    expect(attribute(rows[1]!, ".cron-trigger-icon", "aria-label")).toBe("Trigger configured");
    expect(rows[2]?.classList.contains("cron-table__row--paused")).toBe(true);
    expect(rows[2]?.textContent).toContain("Paused");
    getElement(rows[2] as Element, ".cron-table__name", HTMLButtonElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(paused);
  });

  it("renders a truthful inventory state matrix for the tasks table", () => {
    const pending = renderView({ loading: true, hasLoaded: false, jobs: [], jobsTotal: 0 });
    const pendingStatus = getElement(pending, testId("cron-jobs-loading"), HTMLDivElement);
    expect(pendingStatus.getAttribute("role")).toBe("status");
    expect(pendingStatus.getAttribute("aria-live")).toBe("polite");
    expect(pendingStatus.textContent).toContain("Loading...");
    expect(pending.textContent).not.toContain("No automations yet");
    expect(getElement(pending, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
      "true",
    );
    for (const loading of [false, true]) {
      const empty = renderView({ loading });
      expectAbsent(empty, testId("cron-jobs-loading"));
      const guidance = getElement(empty, ".cron-empty-state", HTMLDivElement);
      expect(guidance.textContent).toContain("No automations yet");
      expect(guidance.textContent).toContain("Describe what OpenClaw should do");
      expect(getElement(empty, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
        loading ? "true" : null,
      );
    }
    const filtered = renderView({ loading: false, hasLoaded: true, jobs: [], jobsQuery: "zzz" });
    expect(getElement(filtered, ".cron-empty-state", HTMLDivElement).textContent).toContain(
      "No automations match the current filters.",
    );
    const refreshing = renderView({
      loading: true,
      hasLoaded: true,
      jobs: [createJob("refresh-me")],
      jobsTotal: 1,
    });
    expect(refreshing.querySelector(testId("cron-jobs-loading"))).toBeNull();
    expect(getElement(refreshing, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(refreshing.textContent).toContain("Daily ping");
    const failed = renderView({
      loading: false,
      hasLoaded: false,
      jobs: [],
      listError: "Unable to load automations.",
    });
    expectAbsent(failed, ".cron-empty-state", testId("cron-jobs-loading"));
    const failedAlert = getElement(failed, ".cron-error-banner", HTMLDivElement);
    expect(failedAlert.getAttribute("role")).toBe("alert");
    expect(failedAlert.textContent).toContain("Unable to load automations.");
    const unrelatedFailure = renderView({ error: "Run history unavailable." });
    expect(text(unrelatedFailure, ".cron-empty-state")).toContain("No automations yet");
    expect(text(unrelatedFailure, '.cron-error-banner[role="alert"]')).toContain(
      "Run history unavailable.",
    );
  });
});

describe("cron view editor", () => {
  it("wires shared text and select controls without changing their field ownership", async () => {
    const onFormChange = vi.fn();
    const container = renderEditor(
      {
        scheduleKind: "cron",
        deliveryMode: "announce",
        deliveryChannel: "telegram",
        failureAlertMode: "custom",
        failureAlertDeliveryMode: "webhook",
        failureAlertChannel: "retired-channel",
      },
      {
        channels: ["telegram"],
        channelMeta: [{ id: "telegram", label: "", detailLabel: "Telegram" }],
        channelLabels: { telegram: "Telegram fallback" },
        onFormChange,
      },
    );
    expect(fillInput(container, "#cron-payload-text", "do the thing")).toBeInstanceOf(
      HTMLTextAreaElement,
    );
    expect(onFormChange).toHaveBeenCalledWith({ payloadText: "do the thing" });
    for (const field of ["name", "sessionKey", "deliveryAccountId", "payloadModel"] as const) {
      const id = `cron-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      const input = getElement(container, `#${id}`, HTMLInputElement);
      expect(input.disabled).toBe(false);
      if (field === "sessionKey" || field === "deliveryAccountId") {
        expect(input.placeholder).toBe(field === "sessionKey" ? "agent:main:main" : "default");
      }
      fillInput(container, `#${id}`, field);
      expect(onFormChange).toHaveBeenLastCalledWith({ [field]: field });
    }
    await updatePickers(container);
    const channel = picker(container, "cron-failure-alert-channel");
    await openPicker(channel);
    expect(optionValues(channel)).toContain("retired-channel");
    expect(text(channel, '[data-value="telegram"] .picker-select__label')?.trim()).toBe(
      "Telegram fallback",
    );
    await chooseFocused(channel, "telegram");
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertChannel: "telegram" });
    const mode = picker(container, "cron-failure-alert-delivery-mode");
    await openPicker(mode);
    expect(text(mode, '[role="option"][data-value=""]')).toContain("Inherit global setting");
    await chooseFocused(mode, "");
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertDeliveryMode: "" });
  });

  it("switches schedule inputs by segmented kind and wires kind changes", () => {
    const onFormChange = vi.fn();
    const everyContainer = renderEditor({ scheduleKind: "every" }, { onFormChange });
    expect(everyContainer.querySelector("#cron-every-amount")).not.toBeNull();
    expect(everyContainer.querySelector("#cron-cron-expr")).toBeNull();
    const activeEvery = getElement(
      everyContainer,
      '[data-test-id="cron-schedule-kind-every"] input',
      HTMLInputElement,
    );
    expect(activeEvery.checked).toBe(true);
    selectSchedule(everyContainer, "cron");
    expect(onFormChange).toHaveBeenCalledWith({ scheduleKind: "cron", deleteAfterRun: false });
    selectSchedule(everyContainer, "at");
    expect(onFormChange).toHaveBeenCalledWith({ scheduleKind: "at", deleteAfterRun: true });
    expect(renderEditor({ scheduleKind: "at" }).querySelector("#cron-schedule-at")).not.toBeNull();
    const cronContainer = renderEditor(
      { scheduleKind: "cron", deleteAfterRun: true },
      { onFormChange },
    );
    expect(cronContainer.querySelector("#cron-cron-expr")).not.toBeNull();
    expect(findToggleByLabel(cronContainer, "Delete after run")).toBeNull();
    selectSchedule(cronContainer, "every");
    expect(onFormChange).toHaveBeenCalledWith({ scheduleKind: "every", deleteAfterRun: false });
    const onExitFormChange = vi.fn();
    const onExitContainer = renderEditor(
      { scheduleKind: "on-exit" },
      { onFormChange: onExitFormChange },
    );
    expect(onExitContainer.querySelector(testId("cron-schedule-kind-on-exit"))).not.toBeNull();
    expect(findToggleByLabel(onExitContainer, "Delete after run")).not.toBeNull();
    expect(everyContainer.querySelector(testId("cron-schedule-kind-on-exit"))).toBeNull();
    selectSchedule(onExitContainer, "at");
    expect(onExitFormChange).toHaveBeenCalledWith({ scheduleKind: "at" });
  });

  it("renders supported delivery options and normalizes stale announce selection", async () => {
    const container = renderEditor({
      sessionTarget: "main",
      payloadKind: "systemEvent",
      deliveryMode: "announce",
    });
    await updatePickers(container);
    const delivery = picker(container, "cron-delivery-mode");
    await openPicker(delivery);
    expect(optionValues(delivery)).toEqual(["webhook", "none"]);
    expect(container.querySelector("#cron-delivery-channel")).toBeNull();
  });

  it("shows announce channel/to rows and webhook URL row per delivery mode", async () => {
    const announce = renderEditor({ deliveryMode: "announce" }, { channels: ["telegram"] });
    await updatePickers(announce);
    expect(announce.querySelector("#cron-delivery-channel")).not.toBeNull();
    expect(announce.querySelector("#cron-delivery-to")).not.toBeNull();
    const webhook = renderEditor(
      { deliveryMode: "webhook" },
      { fieldErrors: { deliveryTo: "cron.errors.webhookUrlRequired" }, canSubmit: false },
    );
    expectInvalidField(webhook, "delivery-to", "deliveryTo", "Webhook URL is required.");
  });

  it("waits for scheduler status before presenting trigger capability", () => {
    const pending = renderEditor({}, { status: null });
    expect(findToggleByLabel(pending, "Condition trigger")).toBeNull();
    expect(pending.textContent).not.toContain("disabled by cron.triggers.enabled");
  });

  it("hides trigger authoring when the operator disabled triggers but keeps clear available", () => {
    const onFormChange = vi.fn();
    const status = { enabled: true, triggersEnabled: false, jobs: 0 };
    const disabled = renderEditor({}, { status, onFormChange });
    expect(disabled.querySelector("#cron-trigger-script")).toBeNull();
    expect(disabled.textContent).toContain("disabled by cron.triggers.enabled");
    const configured = renderEditor(
      { triggerEnabled: true, triggerScript: "json({ fire: true })" },
      { status, onFormChange },
    );
    getButtonByText(configured, "Clear trigger").click();
    expect(onFormChange).toHaveBeenCalledWith({ triggerEnabled: false });
  });

  it("keeps an incompatible existing script condition trigger visible and explicitly clearable", async () => {
    const onFormChange = vi.fn();
    const script = "const result = await agent('check status')";
    const job = createJob("job-script-trigger", {
      payload: { kind: "script", script },
      trigger: { script: "json({ fire: true })" },
    });
    const container = renderView({
      jobs: [job],
      editingJob: job,
      onFormChange,
      form: {
        ...DEFAULT_CRON_FORM,
        name: job.name,
        payloadKind: "script",
        payloadLocked: true,
        payloadText: script,
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      fieldErrors: { triggerScript: "cron.errors.triggerScriptPayloadUnsupported" },
      canSubmit: false,
    });
    expect(findToggleByLabel(container, "Condition trigger")).toBeNull();
    expect(container.querySelector("#cron-trigger-script")).toBeNull();
    expect(container.textContent).toContain("Script payloads cannot use condition triggers");
    const payload = getElement(container, "#cron-payload-text", HTMLPreElement);
    expect(payload.textContent).toBe(script);
    await waitForSolid(() => expect(text(payload, ".hljs-keyword")).toBe("const"));
    expect(text(payload, ".hljs-string")).toBe("'check status'");
    expect(container.querySelector("textarea#cron-payload-text")).toBeNull();
    getButtonByText(container, "Clear trigger").click();
    expect(onFormChange).toHaveBeenCalledWith({ triggerEnabled: false });
  });

  it("attaches the triggered minimum-interval error to the visible recurring interval", async () => {
    const container = renderEditor(
      {
        everyAmount: "5",
        everyUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      { canSubmit: false, fieldErrors: { everyAmount: "cron.errors.triggerIntervalTooShort" } },
    );
    expectInvalidField(container, "every-amount", "everyAmount", "at least every 30 seconds");
    expect(text(container, ".cron-schedule-summary")).toContain("Runs every 5 seconds");
    await updatePickers(container);
    const unit = Array.from(container.querySelectorAll("openclaw-select-picker")).find(
      (candidate) => attribute(candidate, '[role="listbox"]', "aria-label") === "Unit",
    );
    await openPicker(unit!);
    expect(unit?.querySelector('[role="option"][data-value="seconds"]')).toBeInstanceOf(
      HTMLElement,
    );
  });

  it("allows ordinary migrated jobs to be edited, paused, cloned, and removed", async () => {
    const job = createJob("migrated-checklist", {
      payload: { kind: "agentTurn", message: "Review the checklist" },
    });
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const onClone = vi.fn();
    const onRemove = vi.fn();
    const actions = { onRun, onToggle, onClone, onRemove };
    const list = renderView({ jobs: [job], ...actions });
    getElement(list, `[data-test-id="cron-row-run-${job.id}"]`, HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledWith(job, "force");
    const toggle = getElement(
      list,
      `[data-test-id="cron-row-toggle-${job.id}"] input`,
      HTMLInputElement,
    );
    toggle.click();
    expect(onToggle).toHaveBeenCalledWith(job, false);
    await openCronMenu(list, ".cron-job-menu");
    getElement(list, '[data-value="clone"]', HTMLButtonElement).click();
    await waitForSolid(() => expect(onClone).toHaveBeenCalledWith(job));
    const detail = renderView({
      editingJob: job,
      form: { ...DEFAULT_CRON_FORM, payloadKind: "agentTurn", payloadText: "Review the checklist" },
      ...actions,
    });
    expect(getElement(detail, ".cron-editor", HTMLFieldSetElement).disabled).toBe(false);
    expect(getElement(detail, testId("cron-submit"), HTMLButtonElement).disabled).toBe(false);
    expect(detail.querySelector(testId("cron-toggle-enabled"))).not.toBeNull();
    getElement(detail, testId("cron-run-now"), HTMLButtonElement).click();
    expect(onRun).toHaveBeenLastCalledWith(job, "force");
    await openCronMenu(detail, ".cron-job-menu");
    getElement(detail, '[data-value="run-if-due"]', HTMLButtonElement).click();
    await waitForSolid(() => expect(onRun).toHaveBeenLastCalledWith(job, "due"));
    await openCronMenu(detail, ".cron-job-menu");
    getElement(detail, '[data-value="remove"]', HTMLButtonElement).click();
    await waitForSolid(() => expect(onRemove).toHaveBeenCalledWith(job));
  });
});
