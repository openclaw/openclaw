import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { CronJob } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  cronListResponse,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { createCronViewJob } from "./view.test-support.ts";
import "./cron-page.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("retains the editor draft, filters and loaded jobs through reconnect while fencing old reads", async () => {
  const job = createCronViewJob("saved", { name: "Saved automation" });
  const stale = createDeferred<ReturnType<typeof cronListResponse>>();
  const fresh = createDeferred<ReturnType<typeof cronListResponse>>();
  const save = createDeferred<CronJob>();
  const fallback = createRequest();
  let lists = 0;
  const client = createTestGatewayClient((method) => {
    if (method === "cron.list") {
      lists += 1;
      return lists === 1 ? cronListResponse([job]) : lists === 2 ? stale.promise : fresh.promise;
    }
    if (method === "cron.get") {
      return job;
    }
    if (method === "cron.update") {
      return save.promise;
    }
    return fallback(method);
  });
  const gateway = createGateway(client, true);
  const page = createPage(createContext(gateway), { render: true });
  await waitForCronPage(() => expect(page.cron.cronJobs).toHaveLength(1));
  page.selectJob(job);
  page.patchForm({ name: "Unsaved name", payloadText: "Unsaved prompt" });
  page.cron.cronJobsQuery = "saved";
  gateway.emitRetiredEvent({ type: "event", event: "cron", payload: {} });
  await waitForCronPage(() => expect(lists).toBe(2));
  gateway.emitSnapshot({ phase: "reconnecting", hello: null });
  await page.settle();
  expect(page.cron.cronEditingJob?.id).toBe("saved");
  expect(page.cron.cronForm.name).toBe("Unsaved name");
  expect(page.cron.cronForm.payloadText).toBe("Unsaved prompt");
  expect(page.cron.cronJobsQuery).toBe("saved");
  expect(page.cron.cronJobs).toHaveLength(1);
  gateway.emitSnapshot({ phase: "connected", hello: operatorHello(["operator.admin"]) });
  await waitForCronPage(() => expect(lists).toBe(3));
  stale.resolve(cronListResponse([]));
  await page.settle();
  expect(page.cron.cronJobs).toHaveLength(1);
  fresh.resolve(cronListResponse([job]));
  await page.settle();
  expect(page.cron.cronForm.name).toBe("Unsaved name");
  page.submitForm();
  expect(page.cron.cronBusy).toBe(true);
  gateway.emitSnapshot({ phase: "reconnecting" });
  gateway.emitSnapshot({ phase: "connected" });
  save.resolve({ ...job, name: "Saved by an old request" });
  await page.settle();
  expect(page.cron.cronForm.name).toBe("Unsaved name");
  gateway.emitSnapshot({ client: createTestGatewayClient(createRequest()), phase: "reconnecting" });
  await page.settle();
  expect(page.cron.cronForm.name).toBe("");
  expect(page.cron.cronJobs).toEqual([]);
});

it.each([
  "keep",
  "show all runs",
  "close",
  "another job",
  "agent scope",
  "gateway identity",
  "authenticated identity",
])("reconnect respects the current automation selection after %s", async (intent) => {
  vi.useFakeTimers();
  const linked = createCronViewJob("linked", { name: "Linked automation" });
  const other = createCronViewJob("other", { name: "Other automation" });
  const fallback = createRequest();
  let refreshed = false;
  const runRequests: unknown[] = [];
  const request = vi.fn((method: string, params?: unknown) => {
    if (method === "cron.list") {
      return cronListResponse([linked, other]);
    }
    if (method === "cron.get") {
      const id = (params as { id: string }).id;
      const job = id === linked.id ? linked : other;
      return refreshed ? { ...job, name: `Fresh ${job.name}` } : job;
    }
    if (method === "cron.runs") {
      runRequests.push(params);
      return {
        entries: [
          { ts: 1, jobId: linked.id, action: "finished", runId: "target", summary: "Linked run" },
        ],
        total: 1,
        hasMore: false,
      };
    }
    return fallback(method);
  });
  const client = createTestGatewayClient(request);
  const gateway = createGateway(client, true);
  const context = createContext(gateway);
  const page = createPage(context, { render: true });
  page.routeSearch = "?job=linked&run=target";
  await waitForCronPage(() =>
    expect(page.querySelector(".cron-run-entry--highlighted")?.textContent).toContain("Linked run"),
  );

  let expected: CronJob | null = linked;
  if (intent === "show all runs") {
    const showAll = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Show all runs",
    );
    expect(showAll).toBeDefined();
    showAll!.click();
    await waitForCronPage(() =>
      expect(page.querySelector(".cron-run-entry--highlighted")).toBeNull(),
    );
    expect(runRequests.at(-1)).toMatchObject({ id: linked.id, runId: undefined });
  } else if (intent === "close" || intent === "another job") {
    page.querySelector<HTMLButtonElement>('[data-test-id="cron-back"]')!.click();
    await page.settle();
    expected = null;
    if (intent === "another job") {
      page.querySelector<HTMLElement>('[data-test-id="cron-row-other"]')!.click();
      await page.settle();
      expected = other;
    }
  } else if (intent === "agent scope") {
    context.agentSelection.setScope("writer");
    expected = null;
  } else if (intent === "gateway identity") {
    page.context = createContext(createGateway(client, true));
    page.refreshView();
    expected = null;
  }
  if (intent === "authenticated identity") {
    gateway.emitSnapshot({
      hello: {
        ...operatorHello(["operator.admin"]),
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          recoveryScope: "replacement-identity",
        },
      },
    });
    expected = null;
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(page.cron.cronJobsSnapshotRevision).not.toBeNull();
  refreshed = true;
  gateway.emitSnapshot({ phase: "reconnecting" });
  await page.settle();
  gateway.emitSnapshot({ phase: "connected" });
  await vi.advanceTimersByTimeAsync(0);
  await page.settle();

  await waitForCronPage(() => {
    expect(page.cron.cronJobsSnapshotRevision).not.toBeNull();
    expect(page.cron.cronEditingJob?.id ?? null).toBe(expected?.id ?? null);
    expect(page.querySelector(".cron-detail-title")?.textContent ?? null).toBe(
      expected ? expected.name : null,
    );
  });
  if (expected) {
    expect(runRequests.at(-1)).toMatchObject({
      id: expected.id,
      runId: intent === "keep" ? "target" : undefined,
    });
  }
  expect(page.querySelector(".cron-run-entry--highlighted")?.textContent ?? null).toEqual(
    intent === "keep" ? expect.stringContaining("Linked run") : null,
  );
  // The original link remains in the URL even after a newer local selection.
  expect(page.routeSearch).toBe("?job=linked&run=target");
});
