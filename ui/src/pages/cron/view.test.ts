// Control UI tests cover the Automations (cron) list pane and select controls.
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadMarkdownHighlighter } from "../../components/markdown-code-blocks.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createCronViewJob as createJob,
  findToggleByLabel,
  getButtonByText,
  getElement,
  openCronMenu,
  selectSegmented,
  renderCronView as renderView,
} from "./view.test-support.ts";

beforeAll(loadMarkdownHighlighter);

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

    const active = getElement(container, '[data-test-id="cron-tab-enabled"]', HTMLElement);
    expect(active.getAttribute("aria-selected")).toBe("true");

    getElement(container, '[data-test-id="cron-tab-disabled"]', HTMLElement).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    expect(onListTabChange).toHaveBeenCalledWith("tasks");
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsEnabledFilter: "disabled" });

    getElement(container, '[data-test-id="cron-list-tab-activity"]', HTMLElement).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    expect(onListTabChange).toHaveBeenCalledWith("activity");
  });

  it("wires search and the advanced jobs filter popover", () => {
    const onJobsFiltersChange = vi.fn();
    const container = renderView({ onJobsFiltersChange });

    const search = getElement(container, ".cron-search-box input", HTMLInputElement);
    search.value = "brief";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsQuery: "brief" });

    const scheduleFilter = getElement(
      container,
      '[data-test-id="cron-jobs-schedule-filter"]',
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

    const lastStatusFilter = getElement(
      container,
      '[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    lastStatusFilter.value = "unknown";
    lastStatusFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsLastStatusFilter: "unknown" });

    const triggerFilter = getElement(
      container,
      '[data-test-id="cron-jobs-trigger-filter"]',
      HTMLSelectElement,
    );
    triggerFilter.value = "conditional";
    triggerFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({
      cronJobsTriggerFilter: "conditional",
    });

    const reset = getElement(
      container,
      '[data-test-id="cron-jobs-filters-reset"]',
      HTMLButtonElement,
    );
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
    const container = renderView({
      jobs: [job, paused, failed],
      onSelectJob,
    });

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
    expect(rows[0]?.querySelector(".cron-table__state--error")?.getAttribute("aria-label")).toBe(
      "Error",
    );
    expect(rows[0]?.querySelector(".cron-last-glyph--error")).not.toBeNull();
    expect(rows[0]?.querySelector(".cron-table__last-run")?.getAttribute("aria-label")).toBe(
      "Error",
    );
    expect(rows[1]?.textContent).toContain("Cron 0 9 * * *");
    expect(rows[1]?.querySelector(".cron-last-glyph--ok")).toBeNull();
    expect(rows[1]?.textContent).toContain("n/a");
    expect(rows[1]?.querySelector(".cron-trigger-icon")?.getAttribute("aria-label")).toBe(
      "Trigger configured",
    );
    expect(rows[2]?.classList.contains("cron-table__row--paused")).toBe(true);
    expect(rows[2]?.textContent).toContain("Paused");

    getElement(rows[2] as Element, ".cron-table__name", HTMLButtonElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(paused);
  });

  it("renders a truthful inventory state matrix for the tasks table", () => {
    // Initial pending: polite loading status, not a false completed-empty message.
    const pending = renderView({ loading: true, hasLoaded: false, jobs: [], jobsTotal: 0 });
    const pendingStatus = getElement(pending, '[data-test-id="cron-jobs-loading"]', HTMLDivElement);
    expect(pendingStatus.getAttribute("role")).toBe("status");
    expect(pendingStatus.getAttribute("aria-live")).toBe("polite");
    expect(pendingStatus.textContent).toContain("Loading...");
    expect(pending.textContent).not.toContain("No automations yet");
    expect(getElement(pending, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
      "true",
    );

    // Loaded empty: completed empty guidance with no busy state.
    const loadedEmpty = renderView({ loading: false, hasLoaded: true, jobs: [], jobsTotal: 0 });
    expect(loadedEmpty.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    const empty = getElement(loadedEmpty, ".cron-empty-state", HTMLDivElement);
    expect(empty.textContent).toContain("No automations yet");
    expect(empty.textContent).toContain("Describe what OpenClaw should do");
    expect(
      getElement(loadedEmpty, ".cron-table", HTMLDivElement).getAttribute("aria-busy"),
    ).toBeNull();

    // Filtered empty keeps the matching-copy variant.
    const filtered = renderView({ loading: false, hasLoaded: true, jobs: [], jobsQuery: "zzz" });
    expect(getElement(filtered, ".cron-empty-state", HTMLDivElement).textContent).toContain(
      "No automations match the current filters.",
    );

    // Refresh with retained rows keeps the rows and marks the region busy.
    const refreshing = renderView({
      loading: true,
      hasLoaded: true,
      jobs: [createJob("refresh-me")],
      jobsTotal: 1,
    });
    expect(refreshing.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    expect(getElement(refreshing, ".cron-table", HTMLDivElement).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(refreshing.textContent).toContain("Daily ping");

    // Refresh of a loaded-empty inventory keeps the empty message (no false loading copy).
    const refreshingEmpty = renderView({ loading: true, hasLoaded: true, jobs: [], jobsTotal: 0 });
    expect(refreshingEmpty.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    expect(getElement(refreshingEmpty, ".cron-empty-state", HTMLDivElement).textContent).toContain(
      "No automations yet",
    );

    // A first list failure reports its own error instead of claiming the inventory is empty.
    const failed = renderView({
      loading: false,
      hasLoaded: false,
      jobs: [],
      listError: "Unable to load automations.",
    });
    expect(failed.querySelector(".cron-empty-state")).toBeNull();
    expect(failed.querySelector('[data-test-id="cron-jobs-loading"]')).toBeNull();
    const failedAlert = getElement(failed, ".cron-error-banner", HTMLDivElement);
    expect(failedAlert.getAttribute("role")).toBe("alert");
    expect(failedAlert.textContent).toContain("Unable to load automations.");

    // A non-list failure cannot hide a successfully loaded empty inventory.
    const unrelatedFailure = renderView({
      hasLoaded: true,
      jobs: [],
      error: "Run history unavailable.",
    });
    expect(unrelatedFailure.querySelector(".cron-empty-state")?.textContent).toContain(
      "No automations yet",
    );
    expect(
      unrelatedFailure.querySelector('.cron-error-banner[role="alert"]')?.textContent,
    ).toContain("Run history unavailable.");
  });
});

describe("cron view editor", () => {
  it("wires shared text and select controls without changing their field ownership", async () => {
    const onFormChange = vi.fn();
    const container = renderView({
      createOpen: true,
      channels: ["telegram"],
      channelMeta: [{ id: "telegram", label: "", detailLabel: "Telegram" }],
      channelLabels: { telegram: "Telegram fallback" },
      form: {
        ...DEFAULT_CRON_FORM,
        scheduleKind: "cron",
        deliveryMode: "announce",
        deliveryChannel: "telegram",
        failureAlertMode: "custom",
        failureAlertDeliveryMode: "webhook",
        failureAlertChannel: "retired-channel",
      },
      onFormChange,
    });

    const prompt = getElement(container, "#cron-payload-text", HTMLTextAreaElement);
    prompt.value = "do the thing";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFormChange).toHaveBeenCalledWith({ payloadText: "do the thing" });

    for (const field of ["name", "sessionKey", "deliveryAccountId", "payloadModel"] as const) {
      const id = `cron-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      const input = getElement(container, `#${id}`, HTMLInputElement);
      expect(input.disabled).toBe(false);
      if (field === "sessionKey" || field === "deliveryAccountId") {
        expect(input.placeholder).toBe(field === "sessionKey" ? "agent:main:main" : "default");
      }
      input.value = field;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onFormChange).toHaveBeenLastCalledWith({ [field]: field });
    }

    await updatePickers(container);
    const channel = getElement(
      container,
      "openclaw-select-picker:has(#cron-failure-alert-channel)",
      HTMLElement,
    );
    await openPicker(channel);
    const optionValues = Array.from(channel.querySelectorAll('[role="option"]'), (option) =>
      option.getAttribute("data-value"),
    );
    expect(optionValues).toContain("retired-channel");
    const telegramOption = channel.querySelector<HTMLElement & { label?: string }>(
      '[role="option"][data-value="telegram"]',
    );
    expect(telegramOption?.querySelector(".picker-select__label")?.textContent?.trim()).toBe(
      "Telegram fallback",
    );
    const channelTrigger = getElement(channel, ".picker-select__trigger", HTMLButtonElement);
    channelTrigger.focus();
    await choosePickerValue(channel, "telegram");
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertChannel: "telegram" });
    expect(channel.querySelector(".picker-select__trigger")).toBe(channelTrigger);
    expect(document.activeElement).toBe(channelTrigger);

    const mode = getElement(
      container,
      "openclaw-select-picker:has(#cron-failure-alert-delivery-mode)",
      HTMLElement,
    );
    await openPicker(mode);
    expect(mode.querySelector('[role="option"][data-value=""]')?.textContent).toContain(
      "Inherit global setting",
    );
    const modeTrigger = getElement(mode, ".picker-select__trigger", HTMLButtonElement);
    modeTrigger.focus();
    await choosePickerValue(mode, "");
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertDeliveryMode: "" });
    expect(mode.querySelector(".picker-select__trigger")).toBe(modeTrigger);
    expect(document.activeElement).toBe(modeTrigger);
  });

  it("switches schedule inputs by segmented kind and wires kind changes", () => {
    const onFormChange = vi.fn();
    const everyContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every" },
      onFormChange,
    });
    document.body.append(everyContainer);
    onTestFinished(() => everyContainer.remove());
    expect(everyContainer.querySelector("#cron-every-amount")).not.toBeNull();
    expect(everyContainer.querySelector("#cron-cron-expr")).toBeNull();
    const activeEvery = getElement(
      everyContainer,
      '[data-test-id="cron-schedule-kind-every"] input',
      HTMLInputElement,
    );
    expect(activeEvery.checked).toBe(true);
    selectSegmented(
      getElement(everyContainer, '[data-test-id="cron-schedule-kind-cron"]', HTMLElement),
    );
    expect(onFormChange).toHaveBeenCalledWith({
      scheduleKind: "cron",
      deleteAfterRun: false,
    });

    selectSegmented(
      getElement(everyContainer, '[data-test-id="cron-schedule-kind-at"]', HTMLElement),
    );
    expect(onFormChange).toHaveBeenCalledWith({
      scheduleKind: "at",
      deleteAfterRun: true,
    });

    const atContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "at" },
    });
    expect(atContainer.querySelector("#cron-schedule-at")).not.toBeNull();

    const cronContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "cron", deleteAfterRun: true },
      onFormChange,
    });
    document.body.append(cronContainer);
    onTestFinished(() => cronContainer.remove());
    expect(cronContainer.querySelector("#cron-cron-expr")).not.toBeNull();
    expect(findToggleByLabel(cronContainer, "Delete after run")).toBeNull();
    selectSegmented(
      getElement(cronContainer, '[data-test-id="cron-schedule-kind-every"]', HTMLElement),
    );
    expect(onFormChange).toHaveBeenCalledWith({
      scheduleKind: "every",
      deleteAfterRun: false,
    });

    // on-exit jobs keep a pill so they can convert to an editable schedule;
    // the on-exit pill only exists while it is the current value.
    const onExitContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "on-exit" },
    });
    const onExitKind = onExitContainer.querySelector('[data-test-id="cron-schedule-kind-on-exit"]');
    expect(onExitKind).not.toBeNull();
    expect(findToggleByLabel(onExitContainer, "Delete after run")).not.toBeNull();
    expect(everyContainer.querySelector('[data-test-id="cron-schedule-kind-on-exit"]')).toBeNull();
    const onExitFormChange = vi.fn();
    const keptOnExitContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "on-exit", deleteAfterRun: false },
      onFormChange: onExitFormChange,
    });
    document.body.append(keptOnExitContainer);
    onTestFinished(() => keptOnExitContainer.remove());
    selectSegmented(
      getElement(keptOnExitContainer, '[data-test-id="cron-schedule-kind-at"]', HTMLElement),
    );
    expect(onExitFormChange).toHaveBeenCalledWith({ scheduleKind: "at" });
  });

  it("renders supported delivery options and normalizes stale announce selection", async () => {
    // systemEvent + main session cannot announce; a stale announce selection
    // must render as none and the announce option must disappear.
    const container = renderView({
      createOpen: true,
      form: {
        ...DEFAULT_CRON_FORM,
        sessionTarget: "main",
        payloadKind: "systemEvent",
        deliveryMode: "announce",
      },
    });
    await updatePickers(container);
    const delivery = getElement(
      container,
      "openclaw-select-picker:has(#cron-delivery-mode)",
      HTMLElement,
    );
    await openPicker(delivery);
    const values = Array.from(delivery.querySelectorAll('[role="option"]'), (option) =>
      option.getAttribute("data-value"),
    );
    expect(values).toEqual(["webhook", "none"]);
    expect(container.querySelector("#cron-delivery-channel")).toBeNull();
  });

  it("shows announce channel/to rows and webhook URL row per delivery mode", async () => {
    const announce = renderView({
      createOpen: true,
      channels: ["telegram"],
      form: { ...DEFAULT_CRON_FORM, deliveryMode: "announce" },
    });
    await updatePickers(announce);
    expect(announce.querySelector("#cron-delivery-channel")).not.toBeNull();
    expect(announce.querySelector("#cron-delivery-to")).not.toBeNull();

    const webhook = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, deliveryMode: "webhook" },
      fieldErrors: { deliveryTo: "cron.errors.webhookUrlRequired" },
      canSubmit: false,
    });
    const urlInput = getElement(webhook, "#cron-delivery-to", HTMLInputElement);
    expect(urlInput.getAttribute("aria-invalid")).toBe("true");
    expect(urlInput.getAttribute("aria-describedby")).toBe("cron-error-deliveryTo");
    expect(webhook.querySelector("#cron-error-deliveryTo")?.textContent).toContain(
      "Webhook URL is required.",
    );
  });

  it("waits for scheduler status before presenting trigger capability", () => {
    const pending = renderView({ createOpen: true, status: null });

    expect(findToggleByLabel(pending, "Condition trigger")).toBeNull();
    expect(pending.textContent).not.toContain("disabled by cron.triggers.enabled");
  });

  it("hides trigger authoring when the operator disabled triggers but keeps clear available", () => {
    const onFormChange = vi.fn();
    const status = { enabled: true, triggersEnabled: false, jobs: 0 };
    const disabled = renderView({ createOpen: true, status, onFormChange });
    expect(disabled.querySelector("#cron-trigger-script")).toBeNull();
    expect(disabled.textContent).toContain("disabled by cron.triggers.enabled");

    const configured = renderView({
      createOpen: true,
      status,
      onFormChange,
      form: {
        ...DEFAULT_CRON_FORM,
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
    });
    getButtonByText(configured, "Clear trigger").click();
    expect(onFormChange).toHaveBeenCalledWith({ triggerEnabled: false });
  });

  it("keeps an incompatible existing script condition trigger visible and explicitly clearable", () => {
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
    expect(payload.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(payload.querySelector(".hljs-string")?.textContent).toBe("'check status'");
    expect(container.querySelector("textarea#cron-payload-text")).toBeNull();
    getButtonByText(container, "Clear trigger").click();
    expect(onFormChange).toHaveBeenCalledWith({ triggerEnabled: false });
  });

  it("attaches the triggered minimum-interval error to the visible recurring interval", async () => {
    const container = renderView({
      createOpen: true,
      canSubmit: false,
      form: {
        ...DEFAULT_CRON_FORM,
        everyAmount: "5",
        everyUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      fieldErrors: { everyAmount: "cron.errors.triggerIntervalTooShort" },
    });

    const interval = getElement(container, "#cron-every-amount", HTMLInputElement);
    expect(interval.getAttribute("aria-invalid")).toBe("true");
    expect(interval.getAttribute("aria-describedby")).toBe("cron-error-everyAmount");
    expect(container.querySelector("#cron-error-everyAmount")?.textContent).toContain(
      "at least every 30 seconds",
    );
    expect(container.querySelector(".cron-schedule-summary")?.textContent).toContain(
      "Runs every 5 seconds",
    );
    await updatePickers(container);
    const unit = Array.from(container.querySelectorAll("openclaw-select-picker")).find(
      (picker) => picker.querySelector('[role="listbox"]')?.getAttribute("aria-label") === "Unit",
    );
    await openPicker(unit!);
    expect(unit?.querySelector('[role="option"][data-value="seconds"]')).toBeInstanceOf(
      HTMLElement,
    );
  });

  it("renders system-owned jobs as view-and-run only", async () => {
    const { declarationKey, payload } = {
      declarationKey: "heartbeat:test",
      payload: { kind: "heartbeat" as const },
    };

    const job = createJob(`system-${payload.kind}`, { declarationKey, payload });
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const onClone = vi.fn();
    const onRemove = vi.fn();
    const list = renderView({ jobs: [job], onRun, onToggle, onClone, onRemove });

    getElement(list, `[data-test-id="cron-row-run-${job.id}"]`, HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledWith(job, "force");
    expect(list.querySelector(`[data-test-id="cron-row-toggle-${job.id}"]`)).toBeNull();
    const listMenu = getElement(list, ".cron-job-menu", HTMLElement);
    expect(listMenu.querySelector('[data-value="run-if-due"]')).not.toBeNull();
    expect(listMenu.querySelector('[data-value="clone"]')).toBeNull();
    expect(listMenu.querySelector('[data-value="remove"]')).toBeNull();

    const detail = renderView({
      editingJob: job,
      form: {
        ...DEFAULT_CRON_FORM,
        payloadKind: payload.kind,
        payloadLocked: true,
      },
      onRun,
      onToggle,
      onClone,
      onRemove,
    });

    expect(getElement(detail, ".cron-editor", HTMLFieldSetElement).disabled).toBe(true);
    expect(detail.querySelector('[data-test-id="cron-submit"]')).toBeNull();
    expect(detail.querySelector('[data-test-id="cron-toggle-enabled"]')).toBeNull();
    getElement(detail, '[data-test-id="cron-run-now"]', HTMLButtonElement).click();
    expect(onRun).toHaveBeenLastCalledWith(job, "force");
    const detailMenu = getElement(detail, ".cron-job-menu", HTMLElement);
    await openCronMenu(detail, ".cron-job-menu");
    getElement(detailMenu, '[data-value="run-if-due"]', HTMLButtonElement).click();
    await waitForSolid(() => expect(onRun).toHaveBeenLastCalledWith(job, "due"));
    expect(detailMenu.querySelector('[data-value="clone"]')).toBeNull();
    expect(detailMenu.querySelector('[data-value="remove"]')).toBeNull();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onClone).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });
});
