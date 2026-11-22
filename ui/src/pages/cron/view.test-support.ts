import { expect, vi } from "vitest";
import type { CronJob, CronRunLogEntry } from "../../api/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { CronProps } from "./view-types.ts";
import { CronView } from "./view.tsx";

export function createCronViewRun(overrides: Partial<CronRunLogEntry> = {}): CronRunLogEntry {
  return { ts: 1, jobId: "job-1", action: "finished", status: "ok", ...overrides };
}

export function cronRunsResponse(entries: CronRunLogEntry[] = []) {
  return { entries, total: entries.length, offset: 0, hasMore: false };
}

export function createCronViewJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
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

export function scheduledJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return createCronViewJob(id, {
    name: "Nightly digest",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "digest" },
    state: {},
    ...overrides,
  });
}

export function createCronViewProps(overrides: Partial<CronProps> = {}): CronProps {
  const retired = new Promise<void>(() => {});
  return {
    listError: null,
    canManage: true,
    connected: true,
    status: { enabled: true, triggersEnabled: true, jobs: overrides.jobs?.length ?? 0 },
    jobs: [],
    error: null,
    notice: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    gateway: null,
    getActionRetired: () => retired,
    fieldErrors: {},
    canSubmit: true,
    editingJob: null,
    cloning: false,
    createOpen: false,
    activityOpen: false,
    detailTab: "settings",
    channels: [],
    channelLabels: {},
    runs: [],
    runsState: "ready",
    runsHasMore: false,
    runsLoadingMore: false,
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsQuery: "",
    runsSortDir: "desc",
    agentsList: null,
    models: { catalog: undefined, agent: undefined },
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    failureAlertToSuggestions: [],
    accountSuggestions: [],
    onDetailTabChange: () => undefined,
    onCancelEdit: () => undefined,
    onFormChange: () => undefined,
    onRefresh: () => Promise.resolve(),
    onSubmit: () => undefined,
    onSelectJob: () => undefined,
    onOpenCreate: () => undefined,
    onClosePanel: () => undefined,
    onClone: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: async () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
  };
}

export async function renderCronView(overrides: Partial<CronProps> = {}) {
  const { container } = mountSolid(() => CronView(createCronViewProps(overrides)));
  await vi.dynamicImportSettled();
  flush();
  return container;
}

export async function openCronMenu(container: Element, selector: string) {
  const trigger = getElement(container, `${selector} .oc-menu-trigger`, HTMLButtonElement);
  trigger.click();
  await waitForSolid(() => {
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("data-state")).toBe("open");
  });
  return trigger;
}

export function getButtonByText(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}"`);
  }
  return button;
}

export function getElement<T extends Element>(
  container: Pick<ParentNode, "querySelector">,
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

const SENTENCE_FREQUENCY: Record<string, string> = {
  at: "once",
  every: "every",
  cron: "custom",
  event: "event",
};

/** Chooses a schedule kind from the frequency menu. */
export function chooseSchedule(root: Pick<ParentNode, "querySelector">, kind: string) {
  getElement(root, '[data-test-id="cron-schedule-frequency"]', HTMLElement).click();
  getElement(
    root,
    `[data-test-id="cron-schedule-frequency-${SENTENCE_FREQUENCY[kind] ?? kind}"]`,
    HTMLButtonElement,
  ).click();
}

export function findToggleByLabel(container: Element, label: string) {
  return (
    Array.from(container.querySelectorAll(".settings-toggle")).find((toggle) =>
      (toggle.closest(".settings-row--toggle") ?? toggle).textContent?.includes(label),
    ) ?? null
  );
}
