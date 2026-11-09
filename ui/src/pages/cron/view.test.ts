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

  it("keeps the phone controls and card metadata in their original layout", async () => {
    const onOpenCreate = vi.fn();
    const phone = await renderView({
      phoneLayout: true,
      canCreate: true,
      onOpenCreate,
      jobs: [
        createJob("phone", { state: { lastRunStatus: "ok", lastRunAtMs: Date.now() - 60_000 } }),
      ],
    });
    expect(phone.querySelector('input[type="search"]')).not.toBeNull();
    expect(phone.querySelector(".cron-search-toggle")).toBeNull();
    expect([...phone.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
      "All",
      "Active",
      "Paused",
      "Activity history",
    ]);
    const phoneRow = getElement(phone, ".cron-table__row", HTMLElement);
    expect(phoneRow.firstElementChild?.classList.contains("cron-table__name")).toBe(true);
    expect(
      phoneRow.querySelector(".cron-table__meta .cron-table__last .cron-last-glyph--ok"),
    ).not.toBeNull();
    expect(phoneRow.querySelector(".cron-table__actions .settings-toggle")).not.toBeNull();
    expect(phoneRow.querySelector(".cron-row-run")?.getAttribute("aria-label")).toBe(
      "Start now: Daily ping",
    );
    expect(phoneRow.querySelector(".cron-table__last-success")).toBeNull();
    expect(phone.querySelectorAll(testId("cron-new-task"))).toHaveLength(1);
    getElement(phone, testId("cron-new-task"), HTMLElement).click();
    expect(onOpenCreate).toHaveBeenCalledOnce();
  });

  it("preserves the complete schedule text with and without a time zone", async () => {
    const container = await renderView({
      jobs: [
        createJob("zoned", {
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Sao_Paulo" },
        }),
        createJob("unzoned", { schedule: { kind: "cron", expr: "0 18 * * *" } }),
      ],
    });
    const zoned = getElement(container, testId("cron-row-zoned"), HTMLElement);
    expect(text(zoned, ".cron-table__schedule .cron-table__cell-value")).toBe(
      "Cron 0 9 * * * (America/Sao_Paulo)",
    );
    const unzoned = getElement(container, testId("cron-row-unzoned"), HTMLElement);
    expect(text(unzoned, ".cron-table__schedule .cron-table__cell-value")).toBe("Cron 0 18 * * *");
  });

  it("renders table rows with independent native buttons for opening tasks", async () => {
    const onSelectJob = vi.fn();
    const job = createJob("job-1", {
      trigger: { script: "json({ fire: true })" },
      state: {
        nextRunAtMs: Date.now() + 60_000,
        lastRunStatus: "ok",
        lastRunAtMs: Date.now() - 60_000,
      },
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
    expect(rows[0]?.querySelector(".cron-table__name")?.textContent).toContain("Last run failed");
    expect(rows[0]?.querySelector(".cron-table__last")).toBeNull();
    expect(rows[1]?.textContent).toContain("Cron 0 9 * * *");
    expect(rows[1]?.querySelector(".cron-last-glyph--ok")).toBeNull();
    const lastSuccess = getElement(rows[1]!, ".cron-table__last-success", HTMLElement);
    expect(lastSuccess.textContent).toMatch(/^Last run .*ago$/);
    expect(lastSuccess.previousElementSibling?.tagName.toLowerCase()).toBe(
      "openclaw-agent-row-chip",
    );
    expect(rows[0]?.querySelector(".cron-table__last-success")).toBeNull();
    expect(rows[2]?.querySelector(".cron-table__last-success")).toBeNull();
    expect(rows[1]?.querySelector(".cron-table__next")?.textContent).toContain("Next ");
    expect(attribute(rows[1]!, ".cron-trigger-icon", "aria-label")).toBe("Trigger configured");
    expect(rows[2]?.classList.contains("cron-table__row--paused")).toBe(true);
    expect(rows[2]?.textContent).toContain("Paused");
    getElement(rows[2] as Element, ".cron-table__name", HTMLButtonElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(paused);
  });

  it("names runs when loading more activity instead of automations", async () => {
    const pending = await renderView({ listTab: "activity", runsState: "pending" });
    expect(text(pending, testId("cron-runs-loading"))).toBe("Loading runs…");
    const container = await renderView({
      listTab: "activity",
      runsHasMore: true,
      runsLoadingMore: true,
    });
    const loading = getElement(container, testId("cron-runs-loading-more"), HTMLElement);
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-label")).toBe("Loading runs…");
    expect(container.querySelector(".cron-load-more")).toBeNull();
    expect(container.textContent).not.toContain("Loading automations…");
  });

  it("renders a truthful inventory state matrix for the tasks table", async () => {
    const pending = await renderView({ loading: true, hasLoaded: false });
    const pendingStatus = getElement(pending, testId("cron-jobs-loading"), HTMLDivElement);
    expect(pendingStatus.getAttribute("role")).toBe("status");
    expect(pendingStatus.getAttribute("aria-live")).toBe("polite");
    expect(pendingStatus.textContent).toContain("Loading automations…");
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
        expect(text(container, ".cron-empty-state")).toContain(
          "Create an automation to schedule work for an agent.",
        );
      }
      if (props.error) {
        expect(text(container, ".callout.danger[role=alert]")).toContain(props.error);
      }
    }
    const failed = await renderView({ hasLoaded: false, listError: "Unable to load automations." });
    expectAbsent(failed, ".cron-empty-state", testId("cron-jobs-loading"));
    const failedAlert = getElement(failed, ".callout.danger[role=alert]", HTMLDivElement);
    expect(failedAlert.getAttribute("role")).toBe("alert");
    expect(failedAlert.textContent).toContain("Unable to load automations.");
  });
});

describe("cron view editor", () => {
  it("previews agent-turn Markdown safely while preserving the editable prompt", async () => {
    const payloadText =
      '# Weekly digest\n\n- **Garden**\n\n<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n[unsafe](javascript:alert(1))';
    const job = createJob("markdown-prompt", {
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: payloadText },
    });
    const container = await renderView({
      editingJob: job,
      form: { ...DEFAULT_CRON_FORM, payloadKind: "agentTurn", payloadText },
    });
    const preview = getElement(container, ".cron-editor .chat-text", HTMLDivElement);
    expect(preview.querySelector("h1")?.textContent).toBe("Weekly digest");
    expect(preview.querySelector("li strong")?.textContent).toBe("Garden");
    expect(preview.querySelector('script, [onerror], a[href^="javascript:"]')).toBeNull();
    expect(getElement(container, "#cron-payload-text", HTMLTextAreaElement).value).toBe(
      payloadText,
    );
    for (const form of [
      { payloadKind: "agentTurn" as const, payloadText: "  " },
      { payloadKind: "systemEvent" as const, payloadText: "# Event" },
      { payloadKind: "script" as const, payloadLocked: true, payloadText: "# Source" },
      { payloadKind: "command" as const, payloadLocked: true, payloadText: "# Source" },
    ]) {
      expect((await renderEditor(form)).querySelector(".cron-editor .chat-text")).toBeNull();
    }
  });

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
