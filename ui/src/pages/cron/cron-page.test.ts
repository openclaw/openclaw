import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { startCronClone } from "../../lib/cron/index.ts";
import { updateCronRunsFilter } from "../../lib/cron/runs.ts";
import * as dom from "./cron-assertions.test-support.ts";
import * as harness from "./cron-page.test-support.tsx";
import { waitForCronPage as waitFor } from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage, emitEvent } from "./cron-rpc.test-support.ts";
import {
  createCronViewJob,
  createCronViewRun,
  cronRunsResponse,
  getButtonByText,
  openCronMenu,
  scheduledJob,
  selectSegmented,
} from "./view.test-support.ts";
import "./cron-page.tsx";

function settle() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function runPage(jobId: string, ts: number, summary: string) {
  return { ...cronRunsResponse([createCronViewRun({ jobId, ts, summary })]), nextOffset: null };
}

function expectRpc(request: unknown, method: string, params: unknown) {
  return waitFor(() => expect(request).toHaveBeenCalledWith(method, params));
}

function expectHistoryTab(page: ParentNode) {
  expect(dom.attribute(page, dom.testId("cron-detail-tab-history"), "aria-selected")).toBe("true");
}

function pacedJob(id: string, overrides: Partial<CronJob> = {}) {
  return createCronViewJob(id, {
    schedule: { kind: "every", everyMs: 60_000 },
    pacing: { min: "5m", max: "1h" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "Check again at the proposed cadence" },
    delivery: { mode: "none" },
    state: {},
    ...overrides,
  });
}

async function submitWhenReady(page: ReturnType<typeof harness.createPage>) {
  await waitFor(() => {
    const button = page.querySelector<HTMLButtonElement>(dom.testId("cron-submit"));
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
  });
  dom.click(page, dom.testId("cron-submit"));
}

async function chooseOneTime(page: ReturnType<typeof harness.createPage>) {
  selectSegmented(page.querySelector(dom.testId("cron-schedule-kind-at")) as HTMLElement);
  await page.settle();
  dom.fillInput(page, "#cron-schedule-at", "2099-01-01T12:00");
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("allows offline drafting but disables submission without a live connection", async () => {
  const request = harness.createRequest();
  const gateway = harness.createGateway({ request } as unknown as GatewayBrowserClient, false);
  gateway.emitSnapshot({
    phase: "reconnecting",
    hello: harness.operatorHello(["operator.admin"]),
  });
  const page = harness.createPage(harness.createContext(gateway), { render: true });
  try {
    (await dom.waitForElement(page, dom.testId("cron-new-task"))).click();
    await page.settle();
    page.patchForm({ name: "Offline draft", payloadText: "Review the garden" });
    await page.settle();
    expect(page.cron.cronFieldErrors).toEqual({});
    expect(page.querySelector<HTMLInputElement>("#cron-name")!.matches(":disabled")).toBe(false);
    for (const id of ["cron-submit", "cron-submit-run"]) {
      const button = page.querySelector<HTMLButtonElement>(dom.testId(id))!;
      expect(button.disabled, id).toBe(true);
      button.click();
    }
    expect(request).not.toHaveBeenCalledWith("cron.add", expect.anything());
    expect(page.cron.cronForm.name).toBe("Offline draft");
  } finally {
    page.remove();
  }
});

it("does not treat an accepted edit as completion of a newer clone", async () => {
  const job = createCronViewJob("earlier-edit", { name: "Garden reminder" });
  const saved = createDeferred<CronJob>();
  const request = cronRpc({
    "cron.list": () => harness.cronListResponse([job]),
    "cron.update": () => saved.promise,
  });
  const { page } = mountCronPage(request);
  try {
    (await dom.waitForElement(page, dom.testId("cron-row-earlier-edit"))).click();
    await dom.waitForElement(page, "#cron-name");
    dom.click(page, dom.testId("cron-submit"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("cron.update", expect.anything()));
    const editor = page.querySelector<HTMLFieldSetElement>(".cron-editor")!;
    expect(editor.disabled).toBe(true);
    expect(editor.getAttribute("aria-busy")).toBe("true");
    expect(page.querySelector<HTMLInputElement>("#cron-name")!.matches(":disabled")).toBe(true);
    expect(page.querySelector<HTMLButtonElement>(dom.testId("cron-back"))!.disabled).toBe(true);
    const submit = page.querySelector<HTMLButtonElement>(dom.testId("cron-submit"))!;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain("Saving");
    // Exercise controller intent replacement; the ordinary clone button is busy-disabled.
    startCronClone(page.cron, job);
    page.cron.cronCreateOpen = true;
    page.refreshView();
    await page.settle();
    expect(dom.inputValue(page, "#cron-name")).toBe("Garden reminder copy");
    const draft = page.cron.cronForm;
    saved.resolve({ ...job, name: "Earlier edit saved" });
    await waitFor(() => expect(page.cron.cronBusy).toBe(false));
    await page.settle();
    expect(page.cron).toMatchObject({ cronCreateOpen: true, cronEditingJob: null });
    expect(page.cron.cronForm).toBe(draft);
    expect(dom.inputValue(page, "#cron-name")).toBe("Garden reminder copy");
  } finally {
    saved.resolve(job);
    page.remove();
  }
});

it("keeps the recurring interval focused as validation changes while typing", async () => {
  const selector = "#cron-every-amount";
  const entered = "30";
  const { page } = mountCronPage(harness.createRequest());
  (await dom.waitForElement(page, dom.testId("cron-new-task"))).click();
  await page.settle();
  const input = page.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  input.focus();
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.settle();
  expect(dom.attribute(page, selector, "aria-invalid")).toBe("true");
  expect(document.activeElement?.matches(selector)).toBe(true);
  for (const character of entered) {
    input.value += character;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.settle();
    expect(document.activeElement?.matches(selector)).toBe(true);
  }
  expect((page.querySelector(selector) as HTMLInputElement).value).toBe(entered);
  expect(dom.attribute(page, selector, "aria-invalid")).toBe("false");
});

it.each([1, 2])("scopes %i attached jobs and opens a sole match", async (count) => {
  const jobs = Array.from({ length: count }, (_, index) =>
    createCronViewJob(`linked-${index}`, { name: `Linked ${index}` }),
  );
  const fallback = harness.createRequest();
  const request = vi.fn(async (method: string, _params?: unknown) =>
    method === "cron.list" ? harness.cronListResponse(jobs) : fallback(method),
  );
  const { page } = mountCronPage(request);
  if (count === 2) {
    await dom.waitForElement(page, "[data-test-id=cron-list-tab-activity]");
    page
      .querySelector<HTMLElement>("[data-test-id=cron-list-tab-activity]")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
    await page.settle();
  }
  page.routeSearch = "?session=agent%3Aops%3Anight-watch&agent=ops";
  await waitFor(() => expect(page.cron.cronJobsTotal).toBe(count));
  await waitFor(() => expect(page.cron.cronJobsSnapshotRevision).not.toBeNull());
  await page.settle();
  expect(request).toHaveBeenCalledWith(
    "cron.list",
    expect.objectContaining({ sessionKey: "agent:ops:night-watch", sessionAgentId: "ops" }),
  );
  expect(page.cron.cronEditingJob?.id ?? null).toBe(count === 1 ? "linked-0" : null);
  if (count === 2) {
    await waitFor(() =>
      expect(dom.attribute(page, "[data-test-id=cron-tab-all]", "aria-selected")).toBe("true"),
    );
  }
  expect(dom.text(page, ".page-subtitle")).toContain("attached to this session");
  page.routeSearch = "";
  await waitFor(() => expect(page.cron.cronSessionFilter).toBeUndefined());
  expect(page.cron.cronEditingJob).toBeNull();
});
it.each(["visible", "later page"])("opens linked history for a job on %s", async (placement) => {
  const job = scheduledJob("linked-job", { agentId: "main", name: "Linked automation" });
  const entry = (runId: string, ts: number, summary: string) =>
    createCronViewRun({ runId, ts, summary, jobId: job.id, status: undefined });
  const jobs = createDeferred<CronJobsListResult>();
  const request = cronRpc(
    {
      "cron.list": () => jobs.promise,
      "cron.get": () => job,
      "cron.status": () => ({ enabled: true, jobs: 1, triggersEnabled: true }),
      "cron.runs": (params) => {
        const filter = params as { id?: string; agentId?: string; runId?: string };
        if (filter.id === job.id && filter.agentId && filter.agentId !== job.agentId) {
          throw new Error("Automation not found");
        }
        const entries =
          filter.id !== job.id
            ? []
            : filter.runId
              ? [entry("cron:linked-job:1", 1, "Linked run")]
              : Array.from({ length: 50 }, (_, i) => entry(`recent-${i}`, i + 2, "Recent run"));
        return cronRunsResponse(entries);
      },
      "models.list": () => ({ models: [] }),
    },
    () => ({}),
  );
  const { page } = mountCronPage(request);
  const previousFilters = {
    cronRunsQuery: "older search",
    cronRunsStatuses: ["error" as const],
    cronRunsDeliveryStatuses: ["not-delivered" as const],
  };
  updateCronRunsFilter(page.cron, previousFilters);
  page.routeSearch = "?job=linked-job&run=cron%3Alinked-job%3A1";
  await waitFor(() => expect(page.cron.cronLoading).toBe(true));
  const inventory = harness.cronListResponse(
    placement === "visible"
      ? [job]
      : Array.from({ length: 50 }, (_, index) => ({
          ...job,
          id: `other-${index}`,
          name: `Other automation ${index}`,
        })),
  );
  if (placement === "later page") {
    inventory.total = 51;
    inventory.hasMore = true;
    inventory.nextOffset = 50;
  }
  jobs.resolve(inventory);
  await waitFor(() => {
    expect(page.cron.cronEditingJob?.id).toBe(job.id);
    expectHistoryTab(page);
    expect(dom.text(page, ".cron-run-entry--highlighted")).toContain("Linked run");
  });
  expect(page.querySelectorAll(".cron-run-entry--highlighted")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith(
    "cron.runs",
    expect.objectContaining({
      id: job.id,
      runId: "cron:linked-job:1",
      query: undefined,
      statuses: undefined,
      deliveryStatuses: undefined,
    }),
  );
  getButtonByText(page, "Show all runs").click();
  await waitFor(() => expect(page.querySelectorAll(".cron-run-entry")).toHaveLength(50));
  expect(page.querySelector(".cron-run-entry--highlighted")).toBeNull();
  updateCronRunsFilter(page.cron, previousFilters);
  page.routeSearch = "?job=linked-job";
  await page.settle();
  expect(request).toHaveBeenLastCalledWith(
    "cron.runs",
    expect.objectContaining({
      id: job.id,
      runId: undefined,
      query: "older search",
      statuses: ["error"],
      deliveryStatuses: ["not-delivered"],
    }),
  );
});

it.each(["selecting another job", "changing agent scope", "opening another link", "disconnecting"])(
  "ignores a pending job link after %s",
  async (action) => {
    const linked = createCronViewJob("linked-job", { state: {} });
    const selected = createCronViewJob("selected-job", { state: {} });
    const pending = createDeferred<CronJob>();
    const request = cronRpc({
      "cron.get": (params) =>
        (params as { id: string }).id === linked.id ? pending.promise : selected,
      "cron.list": () => harness.cronListResponse([selected]),
    });
    const { page, gateway, context } = mountCronPage(request);
    page.routeSearch = "?job=linked-job";
    await expectRpc(request, "cron.get", { id: linked.id });
    await dom.waitForElement(page, dom.testId("cron-row-selected-job"));
    if (action === "selecting another job") {
      dom.click(page, dom.testId("cron-row-selected-job"));
    } else if (action === "changing agent scope") {
      context.agentSelection.setScope("writer");
    } else if (action === "opening another link") {
      page.routeSearch = "?job=selected-job";
    } else {
      gateway.emitSnapshot({ phase: "stopped" });
    }
    const expectedJobId =
      action === "selecting another job" || action === "opening another link" ? selected.id : null;
    await waitFor(() => expect(page.cron.cronEditingJob?.id ?? null).toBe(expectedJobId));
    pending.resolve(linked);
    // Drain the held response and its page update before checking the user's selection.
    await pending.promise;
    await settle();
    await page.settle();
    expect(page.cron.cronEditingJob?.id ?? null).toBe(expectedJobId);
    expect(page.cron.cronError).toBeNull();
  },
);

it("clears a failed job link when opening another link", async () => {
  const job = createCronViewJob("current-job", { state: {} });
  const request = cronRpc({
    "cron.get": (params) => {
      if ((params as { id: string }).id === "removed-job") {
        throw new Error("Automation no longer exists");
      }
      return job;
    },
    "cron.list": () => harness.cronListResponse([job]),
  });
  const { page } = mountCronPage(request);
  page.routeSearch = "?job=removed-job";
  await waitFor(() => expect(page.textContent).toContain("Automation no longer exists"));
  page.routeSearch = "?job=current-job";
  await waitFor(() => expect(page.cron.cronEditingJob?.id).toBe(job.id));
  expect(page.cron.cronError).toBeNull();
  expect(page.textContent).not.toContain("Automation no longer exists");
});

it("drops pending automation scratch when admin access is removed", async () => {
  const job = createCronViewJob("migrated-job", {
    payload: { kind: "agentTurn", message: "Review the checklist" },
    sessionTarget: "main",
  });
  const scratch = createDeferred<object>();
  const request = vi.fn(async (method: string) =>
    method === "cron.list"
      ? harness.cronListResponse([job])
      : method === "cron.scratch.get"
        ? scratch.promise
        : {},
  );
  const { page, gateway } = mountCronPage(request);
  const row = `[data-test-id="cron-row-${job.id}"]`;
  await dom.waitForElement(page, row);
  dom.click(page, `${row} .cron-table__name-text`);
  await dom.waitForElement(page, "openclaw-cron-scratch-editor");
  expect(dom.callsFor(request, "cron.scratch.get")).toHaveLength(0);
  getButtonByText(page, "Load scratch").click();
  await waitFor(() => expect(dom.callsFor(request, "cron.scratch.get")).toHaveLength(1));
  gateway.emitSnapshot({ hello: harness.operatorHello(["operator.read"]) });
  await page.settle();
  scratch.resolve({
    scratch: { content: "private checklist", revision: 1, updatedAtMs: 1 },
    currentRevision: 1,
    maxBytes: 262_144,
  });
  await settle();
  await page.settle();
  expect(page.cron.cronForm.payloadText).toBe("Review the checklist");
  expect(page.textContent).not.toContain("private checklist");
  expect(page.querySelector("openclaw-cron-scratch-editor")).toBeNull();
});

it.each(["operator.write", "operator.read"])(
  "rejects mutations without administrator access for %s",
  async (scope) => {
    const job = scheduledJob("access-job");
    const request = cronRpc({ "cron.list": () => harness.cronListResponse([job]) });
    const { page, gateway } = mountCronPage(request);
    const staleRunButton = await dom.waitForElement(page, dom.testId("cron-row-run-access-job"));
    gateway.emitSnapshot({ hello: harness.operatorHello([scope]) });
    staleRunButton.click();
    await page.settle();
    expect(page.textContent).toContain("Browsing only");
    expect(page.querySelector(dom.testId("cron-row-run-access-job"))).toBeNull();
    expect(
      request.mock.calls.some(([method]) =>
        ["cron.add", "cron.update", "cron.run", "cron.remove"].includes(method),
      ),
    ).toBe(false);
  },
);

it.each([
  ["a suggested task for the selected agent", "writer", true],
  ["a new task from the all-agents view", null, false],
] as const)(
  "creates %s with its intended agent ownership",
  async (_scenario, scopeId, suggested) => {
    const request = harness.createRequest();
    const { page } = mountCronPage(request, { scopeId, selectedId: "writer" });
    await expectRpc(request, "models.list", { agentId: "writer", view: "configured" });
    const createSelector = suggested
      ? '[data-suggestion="repoPulse"]'
      : dom.testId("cron-new-task");
    (await dom.waitForElement(page, createSelector)).click();
    await waitFor(() => {
      expect(page.querySelector("#cron-name")).not.toBeNull();
      expect(page.querySelector("#cron-payload-text")).not.toBeNull();
    });
    dom.fillInput(page, "#cron-name", "Agent-scoped task");
    dom.fillInput(page, "#cron-payload-text", "Run for the selected agent");
    await submitWhenReady(page);
    await expectRpc(
      request,
      "cron.add",
      expect.objectContaining({
        name: "Agent-scoped task",
        agentId: "writer",
        delivery: { mode: "none" },
      }),
    );
  },
);

it.each([
  { destination: "another page", accepted: true },
  { destination: "another automation", accepted: true },
  { destination: "another automation", accepted: false },
  { destination: "the submitted editor", accepted: false },
] as const)(
  "settles create-and-run at $destination (accepted: $accepted)",
  async ({ destination, accepted }) => {
    const addRequested = createDeferred();
    const added = createDeferred<{ id: string }>();
    const selected = createCronViewJob("selected-job", { name: "Selected automation" });
    const request = cronRpc(
      {
        "cron.add": () => {
          addRequested.resolve();
          return added.promise;
        },
        "cron.list": () => harness.cronListResponse([]),
        "cron.get": () => selected,
        "cron.runs": () => cronRunsResponse(),
        "cron.run": () => ({ ok: true, enqueued: true, runId: "run-fresh" }),
        "models.list": () => ({ models: [] }),
      },
      () => ({}),
    );
    const { page, gateway } = mountCronPage(request, { scopeId: "writer" });
    let currentPage = page;
    try {
      (await dom.waitForElement(page, '[data-suggestion="repoPulse"]')).click();
      (await dom.waitForElement(page, dom.testId("cron-submit-run"))).click();
      await addRequested.promise;
      const submittedState = page.cron;
      if (destination === "another page") {
        page.remove();
        currentPage = harness.createPage(harness.createContext(gateway, "writer"));
      }
      if (destination === "another automation") {
        page.routeSearch = `?job=${selected.id}`;
        await waitFor(() => expect(dom.inputValue(page, "#cron-name")).toBe(selected.name));
      }
      await currentPage.settle();
      if (accepted) {
        added.resolve({ id: "job-fresh" });
      } else {
        added.reject(new Error("Creation rejected"));
      }
      await waitFor(() => expect(submittedState.cronBusy).toBe(false));
      await currentPage.settle();
      if (destination === "another automation") {
        expect.soft(currentPage.cron).toMatchObject({
          cronEditingJob: { id: selected.id },
          cronRunsJobId: selected.id,
          cronRunsScope: "job",
        });
        expect.soft(dom.inputValue(currentPage, "#cron-name")).toBe(selected.name);
      }
      if (!accepted) {
        expect(request.mock.calls.some(([method]) => method === "cron.run")).toBe(false);
        expect(currentPage.cron.cronError).toBe(
          destination === "the submitted editor" ? "Creation rejected" : null,
        );
        expect(currentPage.cron.cronCreateOpen).toBe(destination === "the submitted editor");
        return;
      }
      await waitFor(() => {
        const methods = request.mock.calls.map((call) => call[0]);
        expect(methods.indexOf("cron.run")).toBeGreaterThan(methods.indexOf("cron.add"));
      });
      expect(request).toHaveBeenCalledWith(
        "cron.add",
        expect.objectContaining({ agentId: "writer" }),
      );
      expect(request).toHaveBeenCalledWith("cron.run", { id: "job-fresh", mode: "force" });
      await waitFor(() => expect(submittedState.cronCreateOpen).toBe(false));
      if (destination === "another page") {
        expect(currentPage.cron).not.toBe(submittedState);
        expect(currentPage.cron.cronError).toBeNull();
      }
    } finally {
      added.resolve({ id: "job-fresh" });
      currentPage.remove();
    }
  },
);

it.each([
  { outcome: "queued", result: { ok: true, enqueued: true, runId: "run-alpha" } },
  { outcome: "invalid specification", result: { ok: true, ran: false, reason: "invalid-spec" } },
])("keeps selected history after a stale $outcome run", async ({ result }) => {
  const alpha = createCronViewJob("alpha", { name: "Alpha task", state: {} });
  const beta = createCronViewJob("beta", { name: "Beta task", state: {} });
  const overview = runPage(alpha.id, 1, "Overview history only");
  const selected = runPage(beta.id, 2, "Beta history is current");
  const run = createDeferred<unknown>();
  const firstBeta = createDeferred<typeof selected>();
  const fallback = harness.createRequest({ enabled: true, jobs: 2, triggersEnabled: true });
  let betaReads = 0;
  const request = cronRpc(
    {
      "cron.list": () => harness.cronListResponse([alpha, beta]),
      "cron.run": () => run.promise,
      "cron.runs": (params) => {
        if ((params as { id?: string }).id === beta.id) {
          return ++betaReads === 1 ? firstBeta.promise : selected;
        }
        return overview;
      },
    },
    fallback,
  );
  const gateway = harness.createGateway({ request } as unknown as GatewayBrowserClient, true);
  gateway.emitSnapshot({ hello: harness.operatorHello(["operator.admin"]) });
  const page = harness.createPage(harness.createContext(gateway), { render: true });
  try {
    (await dom.waitForElement(page, dom.testId("cron-row-run-alpha"))).click();
    await expectRpc(request, "cron.run", { id: alpha.id, mode: "force" });
    // Run actions stop propagation; the overview still permits selecting another row.
    dom.click(page, '[data-test-id="cron-row-beta"] .cron-table__name');
    await waitFor(() => {
      expect(betaReads).toBe(1);
      expect(page.querySelector(dom.testId("cron-detail-tab-history"))).not.toBeNull();
    });
    (page.querySelector(dom.testId("cron-detail-tab-history")) as HTMLElement).dispatchEvent(
      new MouseEvent("click", { detail: 1, bubbles: true }),
    );
    await page.settle();
    // A notification queued before the acknowledgement must not rescue the stale target.
    expect(page.querySelector(".cron-history")).not.toBeNull();
    emitEvent(gateway, "cron", { jobId: alpha.id, action: "finished" });
    run.resolve(result);
    await waitFor(() =>
      expect((page.querySelector(dom.testId("cron-run-now")) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    firstBeta.resolve(selected);
    await waitFor(() => {
      expect(dom.text(page, ".cron-detail-title")).toContain(beta.name);
      expectHistoryTab(page);
      expect(dom.text(page, ".cron-run-entry") ?? "").toContain("Beta history is current");
      expect(dom.text(page, ".cron-run-entry") ?? "").not.toContain("Overview history only");
    });
  } finally {
    page.remove();
    run.resolve(result);
    firstBeta.resolve(selected);
    await Promise.allSettled([run.promise, firstBeta.promise]);
  }
});

it("syncs form enabled after header pause", async () => {
  const job = scheduledJob("job-1");
  const paused = { ...job, enabled: false, configRevision: "paused" };
  let current = job;
  const request = cronRpc(
    {
      "cron.list": () => harness.cronListResponse([current]),
      "cron.update": () => (current = paused),
      "cron.runs": () => cronRunsResponse(),
      "models.list": () => ({ models: [] }),
    },
    () => ({}),
  );
  const { page } = mountCronPage(request);
  (await dom.waitForElement(page, ".cron-table__row")).click();
  await waitFor(() => expect(page.cron.cronEditingJob?.id).toBe("job-1"));
  expect(page.cron.cronRunsScope).toBe("job");
  expect(page.cron.cronForm.enabled).toBe(true);
  const enabledToggle = await dom.waitForElement<HTMLInputElement>(
    page,
    '[data-test-id="cron-toggle-enabled"] input.settings-toggle__input',
  );
  enabledToggle.checked = false;
  enabledToggle.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => expect(page.cron.cronForm.enabled).toBe(false));
  expect(request).toHaveBeenCalledWith("cron.update", {
    id: job.id,
    expectedConfigRevision: "config-revision-job-1",
    patch: { enabled: false },
  });
});

it.each([
  { name: "maximum bound", kind: "cron", pacing: { max: "1h" }, once: false },
  { name: "a one-time copy", kind: "every", pacing: { min: "5m", max: "1h" }, once: true },
] as const)("duplicates pacing correctly for $name", async ({ kind, pacing, once }) => {
  const source = pacedJob("paced-source", {
    schedule: kind === "every" ? { kind, everyMs: 60_000 } : { kind, expr: "0 9 * * *" },
    pacing,
  });
  const original = structuredClone(source);
  const request = cronRpc({
    "cron.list": () => harness.cronListResponse([source]),
    "cron.add": () => ({ id: "paced-copy" }),
  });
  const { page } = mountCronPage(request);
  await dom.waitForElement(page, ".cron-job-menu");
  await openCronMenu(page, ".cron-job-menu");
  dom.click(page, '.cron-job-menu [data-value="clone"]');
  await dom.waitForElement(page, "#cron-name");
  expect((page.querySelector("#cron-name") as HTMLInputElement).value).toBe("Daily ping copy");
  if (once) {
    await chooseOneTime(page);
  }
  await submitWhenReady(page);
  await expectRpc(
    request,
    "cron.add",
    expect.objectContaining({
      name: "Daily ping copy",
      schedule: expect.objectContaining({ kind: once ? "at" : kind }),
    }),
  );
  await waitFor(() => expect(page.cron.cronCreateOpen).toBe(false));
  const submitted = request.mock.calls.find(([method]) => method === "cron.add")?.[1];
  if (pacing && !once) {
    expect(submitted).toHaveProperty("pacing", pacing);
  } else {
    expect(submitted).not.toHaveProperty("pacing");
  }
  expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
  expect(source).toEqual(original);
});

it.each([false, true])("preserves valid pacing when editing (once: %s)", async (once) => {
  const source = pacedJob("paced-edit");
  const saved: CronJob = {
    ...source,
    name: "Edited task",
    schedule: once ? { kind: "at", at: "2099-01-01T12:00:00.000Z" } : source.schedule,
    pacing: once ? undefined : source.pacing,
    configRevision: "saved-revision",
  };
  const request = cronRpc({
    "cron.list": () => harness.cronListResponse([source]),
    "cron.update": () => saved,
  });
  const { page } = mountCronPage(request);
  (await dom.waitForElement(page, ".cron-table__row")).click();
  await dom.waitForElement(page, "#cron-name");
  dom.fillInput(page, "#cron-name", saved.name);
  await page.settle();
  if (once) {
    await chooseOneTime(page);
    await page.settle();
  }
  const submit = page.querySelector(dom.testId("cron-submit")) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  submit.click();
  await waitFor(() => expect(page.cron.cronEditingJob?.configRevision).toBe("saved-revision"));
  await waitFor(() => expect(page.cron.cronBusy).toBe(false));
  expect(page.cron.cronEditingJob?.name).toBe(saved.name);
  expect(page.querySelector<HTMLButtonElement>(dom.testId("cron-submit"))!.disabled).toBe(false);
  const submitted = request.mock.calls.find(([method]) => method === "cron.update")?.[1];
  expect(submitted).toMatchObject({
    id: source.id,
    expectedConfigRevision: "config-revision-paced-edit",
    patch: { name: saved.name },
  });
  if (once) {
    expect(submitted).toHaveProperty("patch.schedule.kind", "at");
    expect(submitted).toHaveProperty("patch.pacing", null);
  } else {
    expect(submitted).not.toHaveProperty("patch.pacing");
  }
  expect(source.pacing).toEqual({ min: "5m", max: "1h" });
});
