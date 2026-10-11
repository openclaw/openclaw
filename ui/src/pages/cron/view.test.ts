// Control UI tests cover the Automations (cron) list pane and select controls.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { updatePickers, choosePickerValue } from "../../test-helpers/select-picker.ts";
import {
  createCronViewJob as createJob,
  findToggleByLabel,
  getButtonByText,
  getElement,
  selectSegmented,
  renderCronView as renderView,
} from "./view.test-support.ts";

describe("cron view list pane", () => {
  it("identifies the agent on each job in a mixed-agent list", async () => {
    const container = renderView({
      jobs: [
        createJob("home", { agentId: "main" }),
        createJob("research", { agentId: "research" }),
      ],
    });
    document.body.append(container);
    try {
      await Promise.all(
        [...container.querySelectorAll("openclaw-agent-row-chip")].map(
          (chip) => chip.updateComplete,
        ),
      );
      expect(
        [...container.querySelectorAll(".cron-table__row .agent-row-chip")].map((chip) =>
          chip.getAttribute("data-agent-id"),
        ),
      ).toEqual(["main", "research"]);
    } finally {
      container.remove();
    }
  });

  it("combines status filters and run history in one tab row", () => {
    const onJobsFiltersChange = vi.fn();
    const onListTabChange = vi.fn();
    const container = renderView({
      jobsEnabledFilter: "enabled",
      onJobsFiltersChange,
      onListTabChange,
    });

    const labels = Array.from(container.querySelectorAll(".cron-list-hub-tabs wa-tab"), (tab) =>
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
      "on-exit",
      "stream",
    ]);
    for (const scheduleKind of ["on-exit", "stream"] as const) {
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

describe("cron view selects", () => {
  it("shows persisted non-first values in jobs filters and runs sort", () => {
    const activity = renderView({ listTab: "activity", runsSortDir: "asc" });
    const sort = getElement(activity, ".cron-run-sort", HTMLButtonElement);
    expect(sort.textContent).toContain("Oldest first");
    expect(
      activity.querySelector('wa-dropdown-item[value="asc"]')?.getAttribute("aria-current"),
    ).toBe("true");
    const tasks = renderView({ jobsLastStatusFilter: "error" });
    const lastStatus = getElement(
      tasks,
      'select[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    expect(lastStatus.value).toBe("error");
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
    await choosePickerValue(channel, "telegram");
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertChannel: "telegram" });

    const mode = getElement(
      container,
      "openclaw-select-picker:has(#cron-failure-alert-delivery-mode)",
      HTMLElement,
    );
    expect(mode.querySelector('[role="option"][data-value=""]')?.textContent).toContain(
      "Inherit global setting",
    );
    await choosePickerValue(mode, "");
    expect(onFormChange).toHaveBeenLastCalledWith({ failureAlertDeliveryMode: "" });
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

  it("hides the schedule summary for recurring amounts that cannot produce safe milliseconds", () => {
    for (const everyAmount of ["0x10", "1e3", "+1", String(Number.MAX_SAFE_INTEGER), "0.000001"]) {
      const container = renderView({
        createOpen: true,
        form: { ...DEFAULT_CRON_FORM, scheduleKind: "every", everyAmount },
      });
      expect(container.querySelector(".cron-schedule-summary")).toBeNull();
    }
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
    expect(unit?.querySelector('[role="option"][data-value="seconds"]')).toBeInstanceOf(
      HTMLElement,
    );
  });

  it("lets operators manage migrated jobs through ordinary controls", () => {
    const job = createJob("migrated-heartbeat", {
      declarationKey: "heartbeat:main",
      agentId: "main",
      payload: { kind: "agentTurn", message: "Review the daily checklist." },
    });
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const onClone = vi.fn();
    const onRemove = vi.fn();
    const onSubmit = vi.fn();
    const list = renderView({ jobs: [job], onRun, onToggle, onClone, onRemove });

    getElement(list, `[data-test-id="cron-row-run-${job.id}"]`, HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledWith(job, "force");
    const pause = getElement(
      list,
      `[data-test-id="cron-row-toggle-${job.id}"] input.settings-toggle__input`,
      HTMLInputElement,
    );
    pause.checked = false;
    pause.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onToggle).toHaveBeenCalledWith(job, false);
    const listMenu = getElement(list, "wa-dropdown.cron-job-menu", HTMLElement);
    for (const [value, handler] of [
      ["clone", onClone],
      ["remove", onRemove],
    ] as const) {
      const item = getElement(listMenu, `wa-dropdown-item[value="${value}"]`, HTMLElement);
      listMenu.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));
      expect(handler).toHaveBeenCalledWith(job);
    }

    const detail = renderView({
      editingJob: job,
      form: {
        ...DEFAULT_CRON_FORM,
        payloadText: "Review the daily checklist.",
      },
      onRun,
      onToggle,
      onClone,
      onRemove,
      onSubmit,
    });

    expect(getElement(detail, ".cron-editor", HTMLFieldSetElement).disabled).toBe(false);
    expect(getElement(detail, "#cron-payload-text", HTMLTextAreaElement).readOnly).toBe(false);
    getElement(detail, '[data-test-id="cron-submit"]', HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(detail.querySelector('[data-test-id="cron-toggle-enabled"]')).not.toBeNull();
    getElement(detail, '[data-test-id="cron-run-now"]', HTMLButtonElement).click();
    expect(onRun).toHaveBeenLastCalledWith(job, "force");
    const detailMenu = getElement(detail, "wa-dropdown.cron-job-menu", HTMLElement);
    const runIfDue = getElement(detailMenu, 'wa-dropdown-item[value="run-if-due"]', HTMLElement);
    detailMenu.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: runIfDue }, bubbles: true }),
    );
    expect(onRun).toHaveBeenLastCalledWith(job, "due");
  });

  it("locks the editor and back navigation while a save is pending", () => {
    const job = createJob("job-1", { name: "Nightly digest" });
    const container = renderView({ jobs: [job], editingJob: job, busy: true });

    const editor = getElement(container, ".cron-editor", HTMLFieldSetElement);
    const name = getElement(container, "#cron-name", HTMLInputElement);
    const back = getElement(container, '[data-test-id="cron-back"]', HTMLButtonElement);
    const submit = getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement);

    expect(editor.disabled).toBe(true);
    expect(editor.getAttribute("aria-busy")).toBe("true");
    expect(name.matches(":disabled")).toBe(true);
    expect(back.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Saving");
  });

  it("renders model-picker suggestions with the remaining text datalists", async () => {
    const container = renderView({
      createOpen: true,
      agentSuggestions: ["main"],
      modelSuggestions: ["openai/gpt-5.2"],
      thinkingSuggestions: ["low"],
      timezoneSuggestions: ["UTC"],
      deliveryToSuggestions: ["+15551234"],
      accountSuggestions: ["default"],
    });
    for (const id of [
      "cron-agent-suggestions",
      "cron-thinking-suggestions",
      "cron-tz-suggestions",
      "cron-delivery-to-suggestions",
      "cron-delivery-account-suggestions",
    ]) {
      expect(container.querySelector(`datalist#${id}`)).not.toBeNull();
    }
    await updatePickers(container);
    const model = getElement(
      container,
      "openclaw-select-picker:has(#cron-payload-model-picker)",
      HTMLElement,
    );
    expect(model.querySelector('[role="option"][data-value="openai/gpt-5.2"]')).not.toBeNull();
    expect(model.querySelector('[data-provider-icon="codex"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#cron-payload-model")?.hidden).toBe(true);
    // The inherit option must resolve to a real catalog string — a missing key
    // renders the raw "common.default" literal to every locale.
    const inheritText = model.querySelector('[role="option"][data-value=""]')?.textContent ?? "";
    expect(inheritText).toContain("Default");
    expect(inheritText).not.toContain("common.default");
  });
});
