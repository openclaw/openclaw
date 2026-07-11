// Control UI tests cover the Automations (cron) view behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { DEFAULT_CRON_FORM } from "../../lib/cron/index.ts";
import { renderCron } from "./view.ts";

type CronProps = Parameters<typeof renderCron>[0];

function createJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    ...overrides,
  } as CronJob;
}

function createProps(overrides: Partial<CronProps> = {}): CronProps {
  return {
    basePath: "",
    loading: false,
    jobsLoadingMore: false,
    status: null,
    jobs: [],
    jobsTotal: 0,
    jobsHasMore: false,
    jobsQuery: "",
    jobsEnabledFilter: "all",
    jobsScheduleKindFilter: "all",
    jobsLastStatusFilter: "all",
    jobsSortBy: "nextRunAtMs",
    jobsSortDir: "asc",
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    fieldErrors: {},
    canSubmit: true,
    editingJobId: null,
    createOpen: false,
    channels: [],
    channelLabels: {},
    runs: [],
    runsTotal: 0,
    runsHasMore: false,
    runsLoadingMore: false,
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsQuery: "",
    runsSortDir: "desc",
    agentSuggestions: [],
    modelSuggestions: [],
    thinkingSuggestions: [],
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    accountSuggestions: [],
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onSubmit: () => undefined,
    onSelectJob: () => undefined,
    onOpenCreate: () => undefined,
    onClosePanel: () => undefined,
    onClone: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadMoreJobs: () => undefined,
    onJobsFiltersChange: () => undefined,
    onJobsFiltersReset: () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
  };
}

function renderView(overrides: Partial<CronProps> = {}) {
  const container = document.createElement("div");
  render(renderCron(createProps(overrides)), container);
  return container;
}

function getButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

function getElement<T extends Element>(
  container: Element,
  selector: string,
  constructor: new () => T,
): T {
  const element = container.querySelector<T>(selector);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`);
  }
  return element;
}

describe("cron view list pane", () => {
  it("wires the enabled tabs and marks the active one", () => {
    const onJobsFiltersChange = vi.fn();
    const container = renderView({ jobsEnabledFilter: "enabled", onJobsFiltersChange });

    const active = getElement(container, '[data-test-id="cron-tab-enabled"]', HTMLButtonElement);
    expect(active.classList.contains("cron-tab--active")).toBe(true);
    expect(active.getAttribute("aria-selected")).toBe("true");

    getElement(container, '[data-test-id="cron-tab-disabled"]', HTMLButtonElement).click();
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsEnabledFilter: "disabled" });
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
    scheduleFilter.value = "cron";
    scheduleFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsScheduleKindFilter: "cron" });

    const lastStatusFilter = getElement(
      container,
      '[data-test-id="cron-jobs-last-status-filter"]',
      HTMLSelectElement,
    );
    lastStatusFilter.value = "unknown";
    lastStatusFilter.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onJobsFiltersChange).toHaveBeenCalledWith({ cronJobsLastStatusFilter: "unknown" });

    const reset = getElement(
      container,
      '[data-test-id="cron-jobs-filters-reset"]',
      HTMLButtonElement,
    );
    expect(reset.disabled).toBe(true);
  });

  it("enables filter reset when advanced filters are active", () => {
    const onJobsFiltersReset = vi.fn();
    const container = renderView({ jobsScheduleKindFilter: "cron", onJobsFiltersReset });
    const reset = getElement(
      container,
      '[data-test-id="cron-jobs-filters-reset"]',
      HTMLButtonElement,
    );
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(onJobsFiltersReset).toHaveBeenCalledTimes(1);
  });

  it("renders task rows with schedule meta and selects on click", () => {
    const onSelectJob = vi.fn();
    const job = createJob("job-1", { state: { nextRunAtMs: Date.now() + 60_000 } });
    const paused = createJob("job-2", { name: "Paused task", enabled: false });
    const failed = createJob("job-3", {
      name: "Failing task",
      state: { lastRunStatus: "error", lastRunAtMs: Date.now() - 60_000 },
    });
    const container = renderView({
      jobs: [job, paused, failed],
      editingJobId: "job-1",
      onSelectJob,
    });

    const rows = Array.from(container.querySelectorAll(".cron-task"));
    expect(rows).toHaveLength(3);
    expect(rows[0]?.classList.contains("cron-task--selected")).toBe(true);
    expect(rows[0]?.textContent).toContain("Cron 0 9 * * *");
    expect(rows[1]?.classList.contains("cron-task--paused")).toBe(true);
    expect(rows[1]?.textContent).toContain("Paused");
    expect(rows[2]?.querySelector(".cron-task__status--error")).not.toBeNull();

    (rows[1] as HTMLButtonElement).click();
    expect(onSelectJob).toHaveBeenCalledWith(paused);
  });

  it("opens the create panel from the New task button and suggestions", () => {
    const onOpenCreate = vi.fn();
    const container = renderView({ onOpenCreate });

    getElement(container, '[data-test-id="cron-new-task"]', HTMLButtonElement).click();
    expect(onOpenCreate).toHaveBeenCalledWith();

    const suggestion = getElement(
      container,
      '[data-suggestion="morning-brief"]',
      HTMLButtonElement,
    );
    suggestion.click();
    const patch = onOpenCreate.mock.calls.at(-1)?.[0];
    expect(patch).toMatchObject({
      payloadKind: "agentTurn",
      scheduleKind: "cron",
      cronExpr: "0 8 * * 1-5",
      deliveryMode: "announce",
    });
    expect(String(patch.payloadText)).toContain("morning brief");
  });

  it("hides suggestions while any list filter is active", () => {
    expect(renderView({ jobsQuery: "x" }).querySelector(".cron-suggestions")).toBeNull();
    expect(
      renderView({ jobsEnabledFilter: "enabled" }).querySelector(".cron-suggestions"),
    ).toBeNull();
    expect(renderView().querySelector(".cron-suggestions")).not.toBeNull();
  });

  it("shows scheduler status and task counts in the footer", () => {
    const container = renderView({
      status: { enabled: false, jobs: 2 },
      jobs: [createJob("job-1")],
      jobsTotal: 2,
    });
    const footer = getElement(container, ".cron-list-footer", HTMLDivElement);
    expect(footer.textContent).toContain("Scheduler disabled");
    expect(footer.textContent).toContain("1 of 2");
  });
});

describe("cron view overview pane", () => {
  it("renders recent activity with runs sorted newest first and wires run filters", () => {
    const onRunsFiltersChange = vi.fn();
    const container = renderView({
      onRunsFiltersChange,
      runs: [
        { ts: 1_000, jobId: "job-1", status: "ok", summary: "older run" },
        { ts: 2_000, jobId: "job-2", status: "ok", summary: "newer run" },
      ],
      status: { enabled: true, jobs: 2 },
    });

    expect(container.querySelector(".cron-detail-pane")?.textContent).toContain("Recent activity");
    const titles = Array.from(container.querySelectorAll(".cron-run-entry__title")).map((el) =>
      el.textContent?.trim(),
    );
    expect(titles[0]).toContain("job-2");
    expect(titles[1]).toContain("job-1");

    const search = getElement(container, ".cron-run-filter-search input", HTMLInputElement);
    search.value = "fail";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsQuery: "fail" });

    const statusOption = container.querySelector(
      '[data-filter="status"] input[value="error"]',
    ) as HTMLInputElement;
    statusOption.checked = true;
    statusOption.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRunsFiltersChange).toHaveBeenCalledWith({ cronRunsStatuses: ["error"] });
  });

  it("renders run summaries as sanitized markdown", () => {
    const container = renderView({
      runs: [
        {
          ts: 1,
          jobId: "job-1",
          status: "ok",
          summary: "**bold** <script>alert(1)</script>",
        },
      ],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.querySelector("strong")?.textContent).toBe("bold");
    expect(body.querySelector("script")).toBeNull();
  });

  it("shows run errors as the body when no summary exists", () => {
    const container = renderView({
      runs: [{ ts: 1, jobId: "job-1", status: "error", error: "boom" }],
    });
    const body = getElement(container, ".cron-run-entry__body", HTMLDivElement);
    expect(body.textContent).toContain("boom");
  });
});

describe("cron view editor", () => {
  it("renders the create panel with prompt, details, and frequency rows", () => {
    const onSubmit = vi.fn();
    const onClosePanel = vi.fn();
    const container = renderView({ createOpen: true, onSubmit, onClosePanel });

    expect(container.querySelector(".cron-detail-pane")?.textContent).toContain(
      "New scheduled task",
    );
    expect(container.querySelector("#cron-payload-text")).toBeInstanceOf(HTMLTextAreaElement);
    expect(container.querySelector("#cron-name")).toBeInstanceOf(HTMLInputElement);
    expect(container.querySelector("#cron-schedule-kind")).toBeInstanceOf(HTMLSelectElement);

    getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement).click();
    expect(onSubmit).toHaveBeenCalledTimes(1);

    getElement(container, '[data-test-id="cron-form-close"]', HTMLButtonElement).click();
    expect(onClosePanel).toHaveBeenCalledTimes(1);
  });

  it("wires form changes from prompt and name inputs", () => {
    const onFormChange = vi.fn();
    const container = renderView({ createOpen: true, onFormChange });

    const prompt = getElement(container, "#cron-payload-text", HTMLTextAreaElement);
    prompt.value = "do the thing";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFormChange).toHaveBeenCalledWith({ payloadText: "do the thing" });

    const name = getElement(container, "#cron-name", HTMLInputElement);
    name.value = "Thing";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onFormChange).toHaveBeenCalledWith({ name: "Thing" });
  });

  it("switches frequency rows by schedule kind", () => {
    const everyContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "every" },
    });
    expect(everyContainer.querySelector("#cron-every-amount")).not.toBeNull();
    expect(everyContainer.querySelector("#cron-cron-expr")).toBeNull();

    const atContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "at" },
    });
    expect(atContainer.querySelector("#cron-schedule-at")).not.toBeNull();

    const cronContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "cron" },
    });
    expect(cronContainer.querySelector("#cron-cron-expr")).not.toBeNull();

    const onExitContainer = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, scheduleKind: "on-exit" },
    });
    expect(onExitContainer.querySelector("#cron-schedule-kind")).toBeNull();
    // The read-only kind is a property-bound input value, not text content.
    const onExitInputs = Array.from(onExitContainer.querySelectorAll("input"));
    expect(onExitInputs.some((input) => input.value === "On exit")).toBe(true);
  });

  it("renders supported delivery options and normalizes stale announce selection", () => {
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
    const delivery = getElement(container, "#cron-delivery-mode", HTMLSelectElement);
    const values = Array.from(delivery.querySelectorAll("option")).map((option) => option.value);
    expect(values).toEqual(["webhook", "none"]);
    expect(container.querySelector("#cron-delivery-channel")).toBeNull();
  });

  it("shows announce channel/to rows and webhook URL row per delivery mode", () => {
    const announce = renderView({
      createOpen: true,
      channels: ["telegram"],
      form: { ...DEFAULT_CRON_FORM, deliveryMode: "announce" },
    });
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

  it("shows model and reasoning rows only for agent-turn payloads", () => {
    const agentTurn = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, payloadKind: "agentTurn" },
    });
    expect(agentTurn.querySelector("#cron-payload-model")).not.toBeNull();
    expect(agentTurn.querySelector("#cron-payload-thinking")).not.toBeNull();

    const systemEvent = renderView({
      createOpen: true,
      form: { ...DEFAULT_CRON_FORM, payloadKind: "systemEvent", sessionTarget: "main" },
    });
    expect(systemEvent.querySelector("#cron-payload-model")).toBeNull();
  });

  it("disables submit and lists blocking fields when validation fails", () => {
    const container = renderView({
      createOpen: true,
      canSubmit: false,
      form: { ...DEFAULT_CRON_FORM, name: "" },
      fieldErrors: { name: "cron.errors.nameRequired" },
    });
    const submit = getElement(container, '[data-test-id="cron-submit"]', HTMLButtonElement);
    expect(submit.disabled).toBe(true);
    const statusLinks = Array.from(container.querySelectorAll(".cron-form-status__link"));
    expect(statusLinks.some((link) => link.textContent?.includes("Name"))).toBe(true);
    expect(container.textContent).toContain("Fix 1 field to continue.");
  });

  it("renders job mode with header actions and run history", () => {
    const onRun = vi.fn();
    const onToggle = vi.fn();
    const onClone = vi.fn();
    const onRemove = vi.fn();
    const job = createJob("job-1", { name: "Nightly digest" });
    const container = renderView({
      jobs: [job],
      editingJobId: "job-1",
      runs: [{ ts: 5, jobId: "job-1", jobName: "Nightly digest", status: "ok", summary: "ran" }],
      onRun,
      onToggle,
      onClone,
      onRemove,
    });

    expect(getElement(container, ".cron-detail-title", HTMLDivElement).textContent).toContain(
      "Nightly digest",
    );
    expect(container.textContent).toContain("Run history");
    expect(container.querySelector(".cron-run-entry")).not.toBeNull();
    expect(getButtonByText(container, "Save changes")).toBeInstanceOf(HTMLButtonElement);

    getElement(container, '[data-test-id="cron-run-now"]', HTMLButtonElement).click();
    expect(onRun).toHaveBeenCalledWith(job, "force");

    getElement(container, '[data-test-id="cron-toggle-enabled"]', HTMLButtonElement).click();
    expect(onToggle).toHaveBeenCalledWith(job, false);

    getButtonByText(container, "Run if due").click();
    expect(onRun).toHaveBeenCalledWith(job, "due");
    getButtonByText(container, "Clone").click();
    expect(onClone).toHaveBeenCalledWith(job);
    getButtonByText(container, "Remove").click();
    expect(onRemove).toHaveBeenCalledWith(job);
  });

  it("shows the resume action and paused chip for disabled jobs", () => {
    const onToggle = vi.fn();
    const job = createJob("job-1", { enabled: false });
    const container = renderView({ jobs: [job], editingJobId: "job-1", onToggle });
    const toggle = getElement(container, '[data-test-id="cron-toggle-enabled"]', HTMLButtonElement);
    expect(toggle.textContent).toContain("Resume");
    toggle.click();
    expect(onToggle).toHaveBeenCalledWith(job, true);
    expect(getElement(container, ".cron-detail-title", HTMLDivElement).textContent).toContain(
      "Paused",
    );
  });

  it("renders suggestion datalists for agent/model/thinking/timezone", () => {
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
      "cron-model-suggestions",
      "cron-thinking-suggestions",
      "cron-tz-suggestions",
      "cron-delivery-to-suggestions",
      "cron-delivery-account-suggestions",
    ]) {
      expect(container.querySelector(`datalist#${id}`)).not.toBeNull();
    }
    const model = getElement(container, "#cron-payload-model", HTMLInputElement);
    expect(model.getAttribute("list")).toBe("cron-model-suggestions");
  });
});

describe("cron automation ideas", () => {
  it("renders the gallery expanded on an empty page and pre-fills drafts", () => {
    const container = document.createElement("div");
    const onUseSuggestion = vi.fn();

    render(renderCron(createProps({ onUseSuggestion })), container);

    const gallery = getElement(container, '[data-test-id="cron-ideas"]', HTMLDetailsElement);
    expect(gallery.open).toBe(true);

    getElement(container, '[data-test-id="cron-idea-repoPulse"]', HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );

    expect(onUseSuggestion).toHaveBeenCalledTimes(1);
    const draft = onUseSuggestion.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(draft.name).toBe("Repo pulse");
    expect(draft.schedulePreset).toBe("weekdays");
    expect(draft.deliveryPreset).toBe("notify");
    expect(String(draft.prompt)).toContain("pull requests");
  });

  it("collapses the gallery once jobs exist and omits it without a handler", () => {
    const container = document.createElement("div");

    render(
      renderCron(
        createProps({ onUseSuggestion: vi.fn(), jobs: [createJob("job-1")], jobsTotal: 1 }),
      ),
      container,
    );
    const gallery = getElement(container, '[data-test-id="cron-ideas"]', HTMLDetailsElement);
    expect(gallery.open).toBe(false);

    render(renderCron(createProps()), container);
    expect(container.querySelector('[data-test-id="cron-ideas"]')).toBeNull();
  });

  it("offers Create & run now on the final quick-create step", () => {
    const container = document.createElement("div");
    const onCreate = vi.fn();

    render(
      renderCronQuickCreate({
        open: true,
        step: "how",
        draft: createDefaultDraft(),
        onDraftChange: () => undefined,
        onStepChange: () => undefined,
        onCreate,
        onCancel: () => undefined,
      }),
      container,
    );

    getButtonByText(container, "Create").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCreate).toHaveBeenLastCalledWith();

    getButtonByText(container, "Create & run now").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(onCreate).toHaveBeenLastCalledWith({ runNow: true });
  });
});
