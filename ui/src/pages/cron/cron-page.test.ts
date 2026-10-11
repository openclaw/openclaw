import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { startCronClone } from "../../lib/cron/index.ts";
import { updateCronRunsFilter } from "../../lib/cron/runs.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { createCronViewJob, scheduledJob, selectSegmented } from "./view.test-support.ts";
import "./cron-page.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("CronPage header", () => {
  it("uses the shared settings header with concise context and scope actions", async () => {
    const gateway = createGateway(
      { request: createRequest() } as unknown as GatewayBrowserClient,
      false,
    );
    const context = createContext(gateway);
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }, { id: "research" }],
    };
    const page = createPage(context, { render: true });

    await page.settle();

    expect(page.querySelector(".page-title")?.textContent).toBe("Automations");
    expect(page.querySelector(".content-header--settings")).not.toBeNull();
    expect(page.querySelector(".page-subtitle")?.textContent).toBe(
      "Scheduled tasks and recurring agent runs.",
    );
    expect(page.querySelector(".page-header-actions .agent-scope-control")).not.toBeNull();
  });
});

describe("CronPage editor state sync", () => {
  it("does not treat an accepted edit as completion of a newer clone", async () => {
    const job = createCronViewJob("earlier-edit", { name: "Garden reminder" });
    const saved = createDeferred<CronJob>();
    const fallback = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronListResponse([job]);
      }
      if (method === "cron.update") {
        return saved.promise;
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() =>
        expect(page.querySelector('[data-test-id="cron-row-earlier-edit"]')).not.toBeNull(),
      );
      (page.querySelector('[data-test-id="cron-row-earlier-edit"]') as HTMLElement).click();
      await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
      (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();
      await waitForCronPage(() =>
        expect(request).toHaveBeenCalledWith("cron.update", expect.anything()),
      );
      // Exercise controller intent replacement; the ordinary clone button is busy-disabled.
      startCronClone(page.cron, job);
      page.cron.cronCreateOpen = true;
      page.refreshView();
      await page.settle();
      expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
        "Garden reminder copy",
      );
      const draft = page.cron.cronForm;
      saved.resolve({ ...job, name: "Earlier edit saved" });
      await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
      await page.settle();
      expect(page.cron.cronCreateOpen).toBe(true);
      expect(page.cron.cronEditingJob).toBeNull();
      expect(page.cron.cronForm).toBe(draft);
      expect(page.querySelector<HTMLInputElement>("#cron-name")?.value).toBe(
        "Garden reminder copy",
      );
    } finally {
      saved.resolve(job);
      page.remove();
    }
  });

  it("keeps the recurring interval focused as validation changes while typing", async () => {
    const { selector, text } = { selector: "#cron-every-amount", text: "30" };

    const gateway = createGateway(
      { request: createRequest() } as unknown as GatewayBrowserClient,
      true,
    );
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-new-task"]')).not.toBeNull(),
    );
    (page.querySelector('[data-test-id="cron-new-task"]') as HTMLButtonElement).click();
    await page.settle();

    const input = page.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.settle();
    expect(page.querySelector(selector)?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement?.matches(selector)).toBe(true);

    for (const character of text) {
      input.value += character;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await page.settle();
      expect(document.activeElement?.matches(selector)).toBe(true);
    }
    expect((page.querySelector(selector) as HTMLInputElement).value).toBe(text);
    expect(page.querySelector(selector)?.getAttribute("aria-invalid")).toBe("false");
  });

  it.each([1, 2])(
    "opens one attached automation and keeps %i matching jobs scoped",
    async (count) => {
      const jobs = Array.from({ length: count }, (_, index) =>
        createCronViewJob(`linked-${index}`, { name: `Linked ${index}` }),
      );
      const fallback = createRequest();
      const request = vi.fn(async (method: string, _params?: unknown) =>
        method === "cron.list" ? cronListResponse(jobs) : fallback(method),
      );
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      const context = createContext(gateway);
      const page = createPage(context, { render: true });
      if (count === 2) {
        await waitForCronPage(() =>
          expect(page.querySelector("[data-test-id=cron-list-tab-activity]")).not.toBeNull(),
        );
        page
          .querySelector<HTMLElement>("[data-test-id=cron-list-tab-activity]")!
          .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1 }));
        await page.settle();
      }
      page.routeSearch = "?session=agent%3Aops%3Anight-watch&agent=ops";
      await waitForCronPage(() => expect(page.cron.cronJobsTotal).toBe(count));
      await waitForCronPage(() => expect(page.cron.cronJobsSnapshotRevision).not.toBeNull());
      await page.settle();
      expect(request).toHaveBeenCalledWith(
        "cron.list",
        expect.objectContaining({ sessionKey: "agent:ops:night-watch", sessionAgentId: "ops" }),
      );
      expect(page.cron.cronEditingJob?.id ?? null).toBe(count === 1 ? "linked-0" : null);
      if (count === 2) {
        await waitForCronPage(() =>
          expect(
            page.querySelector("[data-test-id=cron-tab-all]")?.getAttribute("aria-selected"),
          ).toBe("true"),
        );
      }
      expect(page.querySelector(".page-subtitle")?.textContent).toContain(
        "attached to this session",
      );
      page.routeSearch = "";
      await waitForCronPage(() => expect(page.cron.cronSessionFilter).toBeUndefined());
      expect(page.cron.cronEditingJob).toBeNull();
    },
  );
  it.each(["visible", "later page"])(
    "opens a linked job's history when the job is on %s",
    async (placement) => {
      const job = scheduledJob("linked-job", {
        agentId: "main",
        name: "Linked automation",
      });
      const jobs = createDeferred<CronJobsListResult>();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "cron.list") {
          return jobs.promise;
        }
        if (method === "cron.get") {
          return job;
        }
        if (method === "cron.status") {
          return { enabled: true, jobs: 1, triggersEnabled: true };
        }
        if (method === "cron.runs") {
          const filter = params as { id?: string; agentId?: string; runId?: string };
          if (filter.id === job.id && filter.agentId && filter.agentId !== job.agentId) {
            throw new Error("Automation not found");
          }
          const entries =
            filter.id !== job.id
              ? []
              : filter.runId
                ? [
                    {
                      ts: 1,
                      jobId: job.id,
                      action: "finished",
                      runId: "cron:linked-job:1",
                      summary: "Linked run",
                    },
                  ]
                : Array.from({ length: 50 }, (_, i) => ({
                    ts: i + 2,
                    jobId: job.id,
                    action: "finished",
                    runId: `recent-${i}`,
                    summary: "Recent run",
                  }));
          return { entries, total: entries.length, offset: 0, hasMore: false };
        }
        if (method === "models.list") {
          return { models: [] };
        }
        return {};
      });
      const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
      const page = createPage(createContext(gateway), { render: true });
      const previousFilters = {
        cronRunsQuery: "older search",
        cronRunsStatuses: ["error" as const],
        cronRunsDeliveryStatuses: ["not-delivered" as const],
      };
      updateCronRunsFilter(page.cron, previousFilters);
      page.routeSearch = "?job=linked-job&run=cron%3Alinked-job%3A1";

      await waitForCronPage(() => expect(page.cron.cronLoading).toBe(true));
      const inventory = cronListResponse(
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

      await waitForCronPage(() => {
        expect(page.cron.cronEditingJob?.id).toBe(job.id);
        expect(
          page
            .querySelector('[data-test-id="cron-detail-tab-history"]')
            ?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(page.querySelector(".cron-run-entry--highlighted")?.textContent).toContain(
          "Linked run",
        );
      });
      expect(page.querySelectorAll(".cron-run-entry--highlighted")).toHaveLength(1);
      expect(request).toHaveBeenCalledWith(
        "cron.runs",
        expect.objectContaining({
          id: job.id,
          runId: "cron:linked-job:1",
          query: undefined,
          status: "all",
          statuses: undefined,
          deliveryStatuses: undefined,
        }),
      );
      const showAll = Array.from(page.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Show all runs",
      );
      expect(showAll).toBeDefined();
      showAll!.click();
      await waitForCronPage(() =>
        expect(page.querySelectorAll(".cron-run-entry")).toHaveLength(50),
      );
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
    },
  );

  it.each([
    "selecting another job",
    "changing agent scope",
    "opening another link",
    "disconnecting",
  ])("ignores a pending job link after %s", async (action) => {
    const linked = createCronViewJob("linked-job", { state: {} });
    const selected = createCronViewJob("selected-job", { state: {} });
    const pending = createDeferred<CronJob>();
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.get") {
        return (params as { id: string }).id === linked.id ? pending.promise : selected;
      }
      if (method === "cron.list") {
        return cronListResponse([selected]);
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const context = createContext(gateway);
    const page = createPage(context, { render: true });
    page.routeSearch = "?job=linked-job";
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith("cron.get", { id: linked.id }),
    );
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-selected-job"]')).not.toBeNull(),
    );

    if (action === "selecting another job") {
      (page.querySelector('[data-test-id="cron-row-selected-job"]') as HTMLElement).click();
    } else if (action === "changing agent scope") {
      context.agentSelection.setScope("writer");
    } else if (action === "opening another link") {
      page.routeSearch = "?job=selected-job";
    } else {
      gateway.emitSnapshot({ phase: "stopped" });
    }
    const expectedJobId =
      action === "selecting another job" || action === "opening another link" ? selected.id : null;
    await waitForCronPage(() => expect(page.cron.cronEditingJob?.id ?? null).toBe(expectedJobId));
    pending.resolve(linked);
    // Drain the held response and its page update before checking the user's selection.
    await pending.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.settle();
    expect(page.cron.cronEditingJob?.id ?? null).toBe(expectedJobId);
    expect(page.cron.cronError).toBeNull();
  });

  it("clears a failed job link when opening another link", async () => {
    const job = createCronViewJob("current-job", { state: {} });
    const fallbackRequest = createRequest();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.get") {
        if ((params as { id: string }).id === "removed-job") {
          throw new Error("Automation no longer exists");
        }
        return job;
      }
      if (method === "cron.list") {
        return cronListResponse([job]);
      }
      return fallbackRequest(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    page.routeSearch = "?job=removed-job";
    await waitForCronPage(() => expect(page.textContent).toContain("Automation no longer exists"));

    page.routeSearch = "?job=current-job";
    await waitForCronPage(() => expect(page.cron.cronEditingJob?.id).toBe(job.id));
    expect(page.cron.cronError).toBeNull();
    expect(page.textContent).not.toContain("Automation no longer exists");
  });

  it("drops pending heartbeat scratch when admin access is removed", async () => {
    const job = createCronViewJob("heartbeat-job", {
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
    });
    const scratch = createDeferred<object>();
    const request = vi.fn(async (method: string) =>
      method === "cron.list"
        ? cronListResponse([job])
        : method === "cron.scratch.get"
          ? scratch.promise
          : {},
    );
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });

    const row = `[data-test-id="cron-row-${job.id}"]`;
    await waitForCronPage(() => expect(page.querySelector(row)).not.toBeNull());
    (page.querySelector(`${row} .cron-table__name-text`) as HTMLElement).click();
    await waitForCronPage(() =>
      expect(request.mock.calls.filter(([method]) => method === "cron.scratch.get")).toHaveLength(
        1,
      ),
    );

    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
    await page.settle();
    scratch.resolve({
      scratch: { content: "private checklist", revision: 1, updatedAtMs: 1 },
      currentRevision: 1,
      maxBytes: 262_144,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await page.settle();

    expect(page.cron.cronForm.payloadText).toBe("");
  });

  it("keeps conflict detail attached to the authoritative job outside active filters", async () => {
    const staleJob: CronJob = {
      id: "filtered-conflict-job",
      name: "Loaded name",
      description: "Loaded description",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 1,
      configRevision: "revision-stale",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "digest" },
      state: {},
    };
    const authoritativeJob: CronJob = {
      ...staleJob,
      name: "Authoritative name",
      description: "Latest Gateway definition",
      updatedAtMs: 2,
      configRevision: "revision-current",
    };
    const conflict = Object.assign(new Error("cron job definition changed"), {
      details: { code: "CRON_JOB_CHANGED" },
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        const query = (params as { query?: string } | undefined)?.query;
        return query === "missing from filtered results"
          ? cronListResponse([])
          : cronListResponse([staleJob]);
      }
      if (method === "cron.update") {
        throw conflict;
      }
      if (method === "cron.get") {
        return authoritativeJob;
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]')).not.toBeNull(),
    );
    (page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]') as HTMLElement).click();
    await waitForCronPage(() => expect(page.cron.cronEditingJob?.id).toBe(staleJob.id));

    page.cron.cronJobsQuery = "missing from filtered results";
    page.refreshView();
    await page.settle();
    const name = page.querySelector("#cron-name") as HTMLInputElement;
    name.value = "My stale edit";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();

    await waitForCronPage(() =>
      expect(page.cron.cronEditingJob?.configRevision).toBe("revision-current"),
    );
    expect(page.cron.cronEditingJob).toEqual(authoritativeJob);
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ query: "missing from filtered results" }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: staleJob.id });
    expect(page.cron.cronJobs).toEqual([]);
    expect(page.cron.cronJobsTotal).toBe(0);
    expect((page.querySelector("#cron-name") as HTMLInputElement).value).toBe(
      authoritativeJob.name,
    );
    expect(page.querySelector(".cron-detail-title")?.textContent).toContain(authoritativeJob.name);
    expect(page.querySelector('[data-test-id="cron-detail-description"]')?.textContent).toContain(
      authoritativeJob.description,
    );
    expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();

    (page.querySelector('[data-test-id="cron-back"]') as HTMLButtonElement).click();
    await waitForCronPage(() => expect(page.cron.cronEditingJob).toBeNull());
    expect(page.querySelector('[data-test-id="cron-row-filtered-conflict-job"]')).toBeNull();
  });

  it("gates scheduler mutations for write-only authentication", async () => {
    const job = scheduledJob("access-job", {
      name: "Readably scheduled task",
      description: "Inspect this task without changing its permissions",
    });
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronListResponse([job]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.write"]) });
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-access-job"]')).not.toBeNull(),
    );
    expect(
      page.querySelector('[data-test-id="cron-row-description-access-job"]')?.textContent,
    ).toContain(job.description);
    expect(Boolean(page.querySelector('[data-test-id="cron-new-task"]'))).toBe(false);
    expect(Boolean(page.querySelector('[data-test-id="cron-row-run-access-job"]'))).toBe(false);
    expect(Boolean(page.querySelector('[data-test-id="cron-row-toggle-access-job"]'))).toBe(false);
    expect(Boolean(page.querySelector("wa-dropdown.cron-job-menu"))).toBe(false);

    (page.querySelector('[data-test-id="cron-row-access-job"]') as HTMLElement).click();
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull(),
    );
    expect(page.querySelector('[data-test-id="cron-detail-description"]')?.textContent).toContain(
      job.description,
    );
    expect(Boolean(page.querySelector('[data-test-id="cron-run-now"]'))).toBe(false);
    expect(Boolean(page.querySelector('[data-test-id="cron-toggle-enabled"]'))).toBe(false);

    const editor = page.querySelector("fieldset.cron-editor") as HTMLFieldSetElement;
    expect(editor.disabled).toBe(true);
    expect(page.querySelector('[data-test-id="cron-submit"]')).toBeNull();
    expect(
      request.mock.calls.some(([method]) =>
        ["cron.add", "cron.update", "cron.run", "cron.remove"].includes(method),
      ),
    ).toBe(false);
  });

  it.each([
    {
      scenario: "a suggested task for the selected agent",
      scopeId: "writer",
      suggested: true,
      expectedAgentId: "writer",
    },
    {
      scenario: "a new task from the all-agents view",
      scopeId: null,
      selectedId: "writer",
      suggested: false,
      expectedAgentId: "writer",
    },
  ])("creates $scenario with its intended agent ownership", async (scenario) => {
    const request = createRequest();
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(
      createContext(gateway, scenario.scopeId, scenario.selectedId ?? scenario.scopeId),
      { render: true },
    );
    await waitForCronPage(() => {
      expect(request).toHaveBeenCalledWith("models.list", {
        agentId: scenario.expectedAgentId,
        view: "configured",
      });
    });

    const createSelector = scenario.suggested
      ? '[data-suggestion="repoPulse"]'
      : '[data-test-id="cron-new-task"]';
    await waitForCronPage(() => expect(page.querySelector(createSelector)).not.toBeNull());
    (page.querySelector(createSelector) as HTMLButtonElement).click();

    await waitForCronPage(() => {
      expect(page.querySelector("#cron-name")).not.toBeNull();
      expect(page.querySelector("#cron-payload-text")).not.toBeNull();
    });
    const name = page.querySelector("#cron-name") as HTMLInputElement;
    name.value = "Agent-scoped task";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const payload = page.querySelector("#cron-payload-text") as HTMLTextAreaElement;
    payload.value = "Run for the selected agent";
    payload.dispatchEvent(new Event("input", { bubbles: true }));

    await waitForCronPage(() => {
      const submit = page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement;
      expect(submit).not.toBeNull();
      expect(submit.disabled).toBe(false);
    });
    (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();

    await waitForCronPage(() => {
      expect(request).toHaveBeenCalledWith(
        "cron.add",
        expect.objectContaining({
          name: "Agent-scoped task",
          agentId: scenario.expectedAgentId,
          delivery: { mode: "none" },
        }),
      );
    });
  });

  it("completes create & run now after navigation", async () => {
    const addRequested = createDeferred();
    const added = createDeferred<{ id: string }>();
    const request = vi.fn(async (method: string) => {
      if (method === "cron.add") {
        addRequested.resolve();
        return added.promise;
      }
      if (method === "cron.list") {
        return cronListResponse([]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "cron.run") {
        return { ok: true, enqueued: true, runId: "run-fresh" };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway, "writer"), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-suggestion="repoPulse"]')).not.toBeNull(),
    );
    (page.querySelector('[data-suggestion="repoPulse"]') as HTMLButtonElement).click();
    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-submit-run"]')).not.toBeNull(),
    );
    (page.querySelector('[data-test-id="cron-submit-run"]') as HTMLButtonElement).click();
    await addRequested.promise;
    const submittedState = page.cron;
    page.remove();
    const currentPage = createPage(createContext(gateway, "writer"));
    await currentPage.settle();
    added.resolve({ id: "job-fresh" });

    await waitForCronPage(() => {
      const methods = request.mock.calls.map((call) => call[0]);
      expect(methods.indexOf("cron.run")).toBeGreaterThan(methods.indexOf("cron.add"));
    });
    expect(request).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({ agentId: "writer" }),
    );
    expect(request).toHaveBeenCalledWith("cron.run", { id: "job-fresh", mode: "force" });
    await waitForCronPage(() => expect(submittedState.cronCreateOpen).toBe(false));
    expect(currentPage.cron).not.toBe(submittedState);
    expect(currentPage.cron.cronError).toBeNull();
  });

  it.each([
    { outcome: "queued", result: { ok: true, enqueued: true, runId: "run-alpha" } },
    { outcome: "invalid specification", result: { ok: true, ran: false, reason: "invalid-spec" } },
  ])("keeps the selected history when an earlier run returns $outcome", async ({ result }) => {
    const alpha = createCronViewJob("alpha", { name: "Alpha task", state: {} });
    const beta = createCronViewJob("beta", { name: "Beta task", state: {} });
    const overview = {
      entries: [
        {
          ts: 1,
          jobId: alpha.id,
          action: "finished",
          status: "ok",
          summary: "Overview history only",
        },
      ],
      total: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    };
    const selected = {
      entries: [
        {
          ts: 2,
          jobId: beta.id,
          action: "finished",
          status: "ok",
          summary: "Beta history is current",
        },
      ],
      total: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    };
    const run = createDeferred<unknown>();
    const firstBeta = createDeferred<typeof selected>();
    const fallback = createRequest({ enabled: true, jobs: 2, triggersEnabled: true });
    let betaReads = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse([alpha, beta]);
      }
      if (method === "cron.run") {
        return run.promise;
      }
      if (method === "cron.runs") {
        if ((params as { id?: string }).id === beta.id) {
          return ++betaReads === 1 ? firstBeta.promise : selected;
        }
        return overview;
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway), { render: true });
    try {
      await waitForCronPage(() =>
        expect(page.querySelector('[data-test-id="cron-row-run-alpha"]')).not.toBeNull(),
      );
      (page.querySelector('[data-test-id="cron-row-run-alpha"]') as HTMLButtonElement).click();
      await waitForCronPage(() =>
        expect(request).toHaveBeenCalledWith("cron.run", { id: alpha.id, mode: "force" }),
      );
      // Run actions stop propagation; the overview still permits selecting another row.
      (
        page.querySelector('[data-test-id="cron-row-beta"] .cron-table__name') as HTMLButtonElement
      ).click();
      await waitForCronPage(() => {
        expect(betaReads).toBe(1);
        expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();
      });
      (page.querySelector('[data-test-id="cron-detail-tab-history"]') as HTMLElement).dispatchEvent(
        new MouseEvent("click", { detail: 1, bubbles: true }),
      );
      await page.settle();
      // A notification queued before the acknowledgement must not rescue the stale target.
      expect(page.querySelector(".cron-history")).not.toBeNull();
      gateway.emitRetiredEvent({
        type: "event",
        event: "cron",
        payload: { jobId: alpha.id, action: "finished" },
      });
      run.resolve(result);
      await waitForCronPage(() =>
        expect(
          (page.querySelector('[data-test-id="cron-run-now"]') as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      firstBeta.resolve(selected);
      await waitForCronPage(() => {
        expect(page.querySelector(".cron-detail-title")?.textContent).toContain(beta.name);
        expect(
          page
            .querySelector('[data-test-id="cron-detail-tab-history"]')
            ?.getAttribute("aria-selected"),
        ).toBe("true");
        expect(page.querySelector(".cron-run-entry")?.textContent ?? "").toContain(
          "Beta history is current",
        );
        expect(page.querySelector(".cron-run-entry")?.textContent ?? "").not.toContain(
          "Overview history only",
        );
      });
    } finally {
      page.remove();
      run.resolve(result);
      firstBeta.resolve(selected);
      await Promise.allSettled([run.promise, firstBeta.promise]);
    }
  });

  it("syncs form enabled after header pause and resets runs scope after remove", async () => {
    const job = scheduledJob("job-1");
    let serverEnabled = true;
    let removed = false;
    const removeRequested = createDeferred();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse(removed ? [] : [{ ...job, enabled: serverEnabled }]);
      }
      if (method === "cron.update") {
        const patch = (params as { patch?: { enabled?: boolean } }).patch;
        if (typeof patch?.enabled === "boolean") {
          serverEnabled = patch.enabled;
        }
        return {
          ...job,
          enabled: serverEnabled,
          updatedAtMs: 1,
          configRevision: "config-revision-job-1-updated",
        };
      }
      if (method === "cron.remove") {
        removed = true;
        removeRequested.resolve();
        return {};
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = createGateway(client, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() => expect(page.querySelector(".cron-table__row")).not.toBeNull());
    (page.querySelector(".cron-table__row") as HTMLElement).click();
    await waitForCronPage(() => expect(page.cron.cronEditingJob?.id).toBe("job-1"));
    expect(page.cron.cronRunsScope).toBe("job");
    expect(page.cron.cronForm.enabled).toBe(true);

    await waitForCronPage(() =>
      expect(
        page.querySelector('[data-test-id="cron-toggle-enabled"] input.settings-toggle__input'),
      ).not.toBeNull(),
    );
    const enabledToggle = page.querySelector(
      '[data-test-id="cron-toggle-enabled"] input.settings-toggle__input',
    ) as HTMLInputElement;
    enabledToggle.checked = false;
    enabledToggle.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForCronPage(() => expect(page.cron.cronForm.enabled).toBe(false));
    expect(serverEnabled).toBe(false);
    expect(request).toHaveBeenCalledWith("cron.update", {
      id: job.id,
      expectedConfigRevision: "config-revision-job-1",
      patch: { enabled: false },
    });

    const findRemoveButton = () =>
      Array.from(page.querySelectorAll<HTMLButtonElement>(".cron-job-menu__item")).find(
        (item) => item.textContent?.trim() === "Remove",
      );
    await waitForCronPage(() => expect(findRemoveButton()?.disabled).toBe(false));
    findRemoveButton()?.click();
    const findConfirmButton = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".exec-approval-actions .btn")).find(
        (button) => button.textContent?.trim() === "Remove",
      );
    await waitForCronPage(() => expect(findConfirmButton()).toBeDefined());
    findConfirmButton()?.click();
    await removeRequested.promise;
    await waitForCronPage(() => expect(page.cron.cronEditingJob).toBeNull());
    await waitForCronPage(() => expect(page.cron.cronRunsScope).toBe("all"));
  });

  it("renders read-only controls and rejects a stale admin action after a scope downgrade", async () => {
    const job = scheduledJob("job-1");
    const request = vi.fn(async (method: string) => {
      if (method === "cron.list") {
        return cronListResponse([job]);
      }
      if (method === "cron.runs") {
        return { entries: [], total: 0, offset: 0, hasMore: false };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      return {};
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });

    await waitForCronPage(() =>
      expect(page.querySelector('[data-test-id="cron-row-run-job-1"]')).not.toBeNull(),
    );
    const staleRunButton = page.querySelector(
      '[data-test-id="cron-row-run-job-1"]',
    ) as HTMLButtonElement;

    gateway.emitSnapshot({ hello: operatorHello(["operator.read"]) });
    staleRunButton.click();
    page.refreshView();
    await page.settle();

    expect(request.mock.calls.some(([method]) => method === "cron.run")).toBe(false);
    expect(page.textContent).toContain("Browsing only");
    expect(page.querySelector('[data-test-id="cron-new-task"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-run-job-1"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-row-job-1"]')).not.toBeNull();

    (page.querySelector('[data-test-id="cron-row-job-1"]') as HTMLElement).click();
    await waitForCronPage(() =>
      expect(page.querySelector(".cron-editor")?.matches(":disabled")).toBe(true),
    );
    expect(page.querySelector('[data-test-id="cron-submit"]')).toBeNull();
    expect(page.querySelector('[data-test-id="cron-detail-tab-history"]')).not.toBeNull();
  });
});

describe("CronPage pacing", () => {
  it.each([
    { name: "maximum bound", kind: "cron", pacing: { max: "1h" }, once: false },
    { name: "a one-time copy", kind: "every", pacing: { min: "5m", max: "1h" }, once: true },
  ] as const)("duplicates pacing correctly for $name", async ({ kind, pacing, once }) => {
    const source = createCronViewJob("paced-source", {
      schedule: kind === "every" ? { kind, everyMs: 60_000 } : { kind, expr: "0 9 * * *" },
      pacing,
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Check again at the proposed cadence" },
      delivery: { mode: "none" },
      state: {},
    });
    const original = structuredClone(source);
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse([source]);
      }
      if (method === "cron.add") {
        return { id: "paced-copy" };
      }
      return fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(page.querySelector(".cron-job-menu")).not.toBeNull());
    page
      .querySelector(".cron-job-menu")!
      .dispatchEvent(
        new CustomEvent("wa-select", { detail: { item: { value: "clone" } }, bubbles: true }),
      );
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    expect((page.querySelector("#cron-name") as HTMLInputElement).value).toBe("Daily ping copy");

    if (once) {
      selectSegmented(page.querySelector('[data-test-id="cron-schedule-kind-at"]') as HTMLElement);
      await page.settle();
      const at = page.querySelector("#cron-schedule-at") as HTMLInputElement;
      at.value = "2099-01-01T12:00";
      at.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await waitForCronPage(() => {
      const submit = page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement;
      expect(submit).not.toBeNull();
      expect(submit.disabled).toBe(false);
    });
    (page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement).click();
    await waitForCronPage(() =>
      expect(request).toHaveBeenCalledWith(
        "cron.add",
        expect.objectContaining({
          name: "Daily ping copy",
          schedule: expect.objectContaining({ kind: once ? "at" : kind }),
        }),
      ),
    );
    await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));
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
    const source = createCronViewJob("paced-edit", {
      schedule: { kind: "every", everyMs: 60_000 },
      pacing: { min: "5m", max: "1h" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Check again at the proposed cadence" },
      delivery: { mode: "none" },
      state: {},
    });
    const saved: CronJob = {
      ...source,
      name: "Edited task",
      schedule: once ? { kind: "at", at: "2099-01-01T12:00:00.000Z" } : source.schedule,
      pacing: once ? undefined : source.pacing,
      configRevision: "saved-revision",
    };
    const fallback = createRequest();
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "cron.list") {
        return cronListResponse([source]);
      }
      return method === "cron.update" ? saved : fallback(method);
    });
    const gateway = createGateway({ request } as unknown as GatewayBrowserClient, true);
    const page = createPage(createContext(gateway), { render: true });
    await waitForCronPage(() => expect(page.querySelector(".cron-table__row")).not.toBeNull());
    (page.querySelector(".cron-table__row") as HTMLElement).click();
    await waitForCronPage(() => expect(page.querySelector("#cron-name")).not.toBeNull());
    const name = page.querySelector("#cron-name") as HTMLInputElement;
    name.value = saved.name;
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await page.settle();
    if (once) {
      selectSegmented(page.querySelector('[data-test-id="cron-schedule-kind-at"]') as HTMLElement);
      await page.settle();
      const at = page.querySelector("#cron-schedule-at") as HTMLInputElement;
      at.value = "2099-01-01T12:00";
      at.dispatchEvent(new Event("input", { bubbles: true }));
      await page.settle();
    }
    const submit = page.querySelector('[data-test-id="cron-submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    submit.click();
    await waitForCronPage(() =>
      expect(page.cron.cronEditingJob?.configRevision).toBe("saved-revision"),
    );
    await waitForCronPage(() => expect(page.cron.cronBusy).toBe(false));
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
});
