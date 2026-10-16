import { afterEach, expect, it, vi } from "vitest";
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
      expected ? `Fresh ${expected.name}` : null,
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
