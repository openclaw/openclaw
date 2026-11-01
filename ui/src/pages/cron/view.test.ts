import { describe, expect, it, vi } from "vitest";
import type { CronFormState } from "../../lib/cron/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { text, testId, attribute } from "./cron-assertions.test-support.ts";
import type { CronProps } from "./view-types.ts";
import {
  createCronViewJob as createJob,
  findToggleByLabel,
  getButtonByText,
  getElement,
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

function expectAbsent(container: Element, ...selectors: string[]) {
  for (const selector of selectors) {
    expect(container.querySelector(selector), selector).toBeNull();
  }
}

function expectInvalidField(container: Element, id: string, errorId: string, message: string) {
  const field = getElement(container, `#cron-${id}`, HTMLInputElement);
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(`cron-error-${errorId}`);
  expect(text(container, `#cron-error-${errorId}`)).toContain(message);
}

describe("cron view list pane", () => {
  it("switches from an active status to paused tasks", async () => {
    const onJobsFiltersChange = vi.fn(),
      onListTabChange = vi.fn();
    const container = await renderView({
      jobsEnabledFilter: "enabled",
      onJobsFiltersChange,
      onListTabChange,
    });
    expect(attribute(container, testId("cron-tab-enabled"), "aria-selected")).toBe("true");
    getElement(container, testId("cron-tab-disabled"), HTMLElement).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    expect(onListTabChange).toHaveBeenCalledWith("tasks");
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsEnabledFilter: "disabled" });
  });

  it("renders table rows with independent native buttons for opening tasks", async () => {
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
    const container = await renderView({ jobs: [job, paused, failed], onSelectJob });
    const rows = Array.from(container.querySelectorAll(".cron-table__row"));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.getAttribute("role")).toBe("listitem");
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

  it("renders a truthful inventory state matrix for the tasks table", async () => {
    const pending = await renderView({ loading: true, hasLoaded: false });
    const pendingStatus = getElement(pending, testId("cron-jobs-loading"), HTMLDivElement);
    expect(pendingStatus.getAttribute("role")).toBe("status");
    expect(pendingStatus.getAttribute("aria-live")).toBe("polite");
    expect(pendingStatus.textContent).toContain("Loading...");
    expect(pending.textContent).not.toContain("No automations yet");
    expect(attribute(pending, ".cron-table", "aria-busy")).toBe("true");
    const states: Array<[Partial<CronProps>, string]> = [
      [{}, "No automations yet"],
      [{ loading: true }, "No automations yet"],
      [{ jobsQuery: "zzz" }, "No automations match the current filters."],
      [{ loading: true, jobs: [createJob("refresh-me")], jobsTotal: 1 }, "Daily ping"],
      [{ error: "Run history unavailable." }, "No automations yet"],
    ];
    for (const [props, message] of states) {
      const container = await renderView(props);
      expectAbsent(container, testId("cron-jobs-loading"));
      expect(text(container, props.jobs ? ".cron-table" : ".cron-empty-state")).toContain(message);
      expect(attribute(container, ".cron-table", "aria-busy")).toBe(props.loading ? "true" : null);
      if (message === "No automations yet") {
        expect(text(container, ".cron-empty-state")).toContain("Describe what OpenClaw should do");
      }
      if (props.error) {
        expect(text(container, '.cron-error-banner[role="alert"]')).toContain(props.error);
      }
    }
    const failed = await renderView({ hasLoaded: false, listError: "Unable to load automations." });
    expectAbsent(failed, ".cron-empty-state", testId("cron-jobs-loading"));
    const failedAlert = getElement(failed, ".cron-error-banner", HTMLDivElement);
    expect(failedAlert.getAttribute("role")).toBe("alert");
    expect(failedAlert.textContent).toContain("Unable to load automations.");
  });
});

describe("cron view editor", () => {
  it("falls back to configured channel labels when metadata has no label", async () => {
    const container = await renderEditor(
      {
        failureAlertMode: "custom",
      },
      {
        channels: ["telegram"],
        channelMeta: [{ id: "telegram", label: "", detailLabel: "Telegram" }],
        channelLabels: { telegram: "Telegram fallback" },
      },
    );
    await updatePickers(container);
    const channel = picker(container, "cron-failure-alert-channel");
    await openPicker(channel);
    expect(text(channel, '[data-value="telegram"] .picker-select__label')?.trim()).toBe(
      "Telegram fallback",
    );
  });

  it("switches schedule inputs by segmented kind and wires kind changes", async () => {
    const onFormChange = vi.fn();
    const everyContainer = await renderEditor({ scheduleKind: "every" }, { onFormChange });
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
    expect(
      (await renderEditor({ scheduleKind: "at" })).querySelector("#cron-schedule-at"),
    ).not.toBeNull();
    const cronContainer = await renderEditor(
      { scheduleKind: "cron", deleteAfterRun: true },
      { onFormChange },
    );
    expect(cronContainer.querySelector("#cron-cron-expr")).not.toBeNull();
    expect(findToggleByLabel(cronContainer, "Delete after run")).toBeNull();
    selectSchedule(cronContainer, "every");
    expect(onFormChange).toHaveBeenCalledWith({ scheduleKind: "every", deleteAfterRun: false });
    const onExitFormChange = vi.fn();
    const onExitContainer = await renderEditor(
      { scheduleKind: "on-exit" },
      { onFormChange: onExitFormChange },
    );
    expect(onExitContainer.querySelector(testId("cron-schedule-kind-on-exit"))).not.toBeNull();
    expect(findToggleByLabel(onExitContainer, "Delete after run")).not.toBeNull();
    expect(everyContainer.querySelector(testId("cron-schedule-kind-on-exit"))).toBeNull();
    selectSchedule(onExitContainer, "at");
    expect(onExitFormChange).toHaveBeenCalledWith({ scheduleKind: "at" });
  });

  it("shows announce channel/to rows and webhook URL row per delivery mode", async () => {
    const announce = await renderEditor({ deliveryMode: "announce" }, { channels: ["telegram"] });
    await updatePickers(announce);
    expect(announce.querySelector("#cron-delivery-channel")).not.toBeNull();
    expect(announce.querySelector("#cron-delivery-to")).not.toBeNull();
    const webhook = await renderEditor(
      { deliveryMode: "webhook" },
      { fieldErrors: { deliveryTo: "cron.errors.webhookUrlRequired" }, canSubmit: false },
    );
    expectInvalidField(webhook, "delivery-to", "deliveryTo", "Webhook URL is required.");
  });

  it("announces field validation errors as alerts", async () => {
    const container = await renderEditor(
      { name: "", everyAmount: "0" },
      {
        fieldErrors: {
          name: "cron.errors.nameRequired",
          everyAmount: "cron.errors.everyAmountInvalid",
        },
        canSubmit: false,
      },
    );
    const alerts = Array.from(container.querySelectorAll('[role="alert"]'), (alert) =>
      alert.textContent?.trim(),
    );
    expect(alerts).toEqual(["Name is required.", "Interval must be greater than 0."]);
    expectInvalidField(container, "name", "name", "Name is required.");
  });

  it("waits for scheduler status before presenting trigger capability", async () => {
    const pending = await renderEditor({}, { status: null });
    expect(findToggleByLabel(pending, "Condition trigger")).toBeNull();
    expect(pending.textContent).not.toContain("disabled by cron.triggers.enabled");
  });

  it("keeps an existing trigger clearable when the operator disabled triggers", async () => {
    const onFormChange = vi.fn();
    const status = { enabled: true, triggersEnabled: false, jobs: 0 };
    const configured = await renderEditor(
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
    const container = await renderView({
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
});
