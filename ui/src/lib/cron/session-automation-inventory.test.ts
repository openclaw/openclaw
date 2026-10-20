/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CronCompactJob, CronJobsListResult } from "../../api/types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { sessionAutomationInventory } from "./session-automation-inventory.ts";

type Page = CronJobsListResult<CronCompactJob>;
const job: CronCompactJob = {
  id: "automation",
  name: "Check task",
  agentId: "ops",
  enabled: true,
  updatedAtMs: 1,
  scheduleKind: "every",
  schedule: { kind: "every", everyMs: 600_000 },
  nextRunAt: null,
  nextRunAtMs: null,
  lastRunAt: null,
  lastRunAtMs: null,
  lastRunStatus: null,
  lastRunError: null,
};
const page = (jobs = [job], options: Partial<Page> = {}): Page => ({
  jobs,
  snapshotRevision: "fixture",
  offset: 0,
  limit: 50,
  total: jobs.length,
  hasMore: false,
  nextOffset: null,
  ...options,
});
function fixture() {
  const request = createGatewayRequestMock().mockResolvedValue(page());
  const source = createApplicationGateway({
    ...createApplicationGateway().gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    assistantAgentId: "ops",
    hello: { type: "hello-ok", protocol: 4, auth: { role: "operator", scopes: ["operator.read"] } },
  });
  return { ...source, request };
}

it("shares one read and upstream lifetime across summary and transcript presentations", async () => {
  const source = fixture();
  const snapshots = vi.spyOn(source.gateway, "subscribe");
  const events = vi.spyOn(source.gateway, "subscribeEvents");
  const pending = createDeferred<Page>();
  source.request.mockReturnValueOnce(pending.promise);
  const summary = sessionAutomationInventory(source.gateway, "agent:ops:task");
  const row = sessionAutomationInventory(source.gateway, "agent:ops:task");
  expect(row).toBe(summary);
  const summaryChanged = vi.fn();
  const rowChanged = vi.fn();
  const stopSummary = summary.observe(summaryChanged, { document, isVisible: () => true });
  const stopRow = row.observe(rowChanged, { document, isVisible: () => true });
  expect(source.request).toHaveBeenCalledTimes(1);
  expect(snapshots).toHaveBeenCalledTimes(1);
  expect(events).toHaveBeenCalledTimes(1);
  pending.resolve(page());
  await pending.promise;
  await summary.load();
  expect(row.read().cron).toBe(summary.read().cron);
  expect(row.read().cron.cronJobs).toEqual([job]);
  stopSummary();
  const summaryNotifications = summaryChanged.mock.calls.length;
  source.publishEvent({
    type: "event",
    event: "cron",
    payload: {
      action: "started",
      jobId: job.id,
      job: { ...job, updatedAtMs: 2, state: { runningAtMs: 2 } },
    },
  });
  expect(row.read().cron.cronJobs[0]?.runningAtMs).toBe(2);
  expect(source.request).toHaveBeenCalledTimes(1);
  expect(summaryChanged).toHaveBeenCalledTimes(summaryNotifications);
  stopRow();
  const rowNotifications = rowChanged.mock.calls.length;
  source.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
  source.publish({ ...source.gateway.snapshot });
  expect(rowChanged).toHaveBeenCalledTimes(rowNotifications);
  expect(source.request).toHaveBeenCalledTimes(1);
  expect(sessionAutomationInventory(source.gateway, "agent:ops:task")).not.toBe(row);
});

it("parks only when the last visible presentation leaves, and shares pagination", async () => {
  const source = fixture();
  const inventory = sessionAutomationInventory(source.gateway, "agent:ops:task");
  source.request.mockResolvedValueOnce(page([job], { total: 2, hasMore: true, nextOffset: 1 }));
  let summaryVisible = true;
  let rowVisible = true;
  const initial = createDeferred();
  const stopSummary = inventory.observe(
    () => {
      if (!inventory.read().cron.cronLoading) {
        initial.resolve();
      }
    },
    { document, isVisible: () => summaryVisible },
  );
  const stopRow = inventory.observe(() => {}, { document, isVisible: () => rowVisible });
  await initial.promise;
  summaryVisible = false;
  inventory.park();
  inventory.activate();
  expect(source.request).toHaveBeenCalledTimes(1);
  const second = { ...job, id: "second" };
  source.request.mockResolvedValueOnce(page([second], { offset: 1, total: 2 }));
  await inventory.load({ append: true });
  expect(inventory.read().cron.cronJobs).toEqual([job, second]);
  expect(source.request.mock.calls[1]?.[1]).toMatchObject({ offset: 1, compact: true });
  rowVisible = false;
  inventory.park();
  source.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
  source.publishEvent({ type: "event", event: "cron", payload: { action: "updated" } });
  expect(source.request).toHaveBeenCalledTimes(2);
  rowVisible = true;
  inventory.activate();
  await inventory.load();
  expect(source.request).toHaveBeenCalledTimes(3);
  stopSummary();
  stopRow();
});

it("isolates Gateway/session inventories and retires pending pages on last release", async () => {
  const first = fixture();
  const other = fixture();
  const pending = createDeferred<Page>();
  first.request.mockReturnValueOnce(pending.promise);
  const inventory = sessionAutomationInventory(first.gateway, "agent:ops:task");
  const stop = inventory.observe(() => {}, { document, isVisible: () => true });
  expect(sessionAutomationInventory(first.gateway, "agent:ops:other")).not.toBe(inventory);
  expect(sessionAutomationInventory(other.gateway, "agent:ops:task")).not.toBe(inventory);
  stop();
  pending.resolve(page());
  await pending.promise;
  expect(inventory.read().cron.cronJobs).toEqual([]);
  const next = sessionAutomationInventory(first.gateway, "agent:ops:task");
  const loaded = createDeferred();
  const stopNext = next.observe(
    () => {
      if (!next.read().cron.cronLoading) {
        loaded.resolve();
      }
    },
    { document, isVisible: () => true },
  );
  await loaded.promise;
  expect(first.request).toHaveBeenCalledTimes(2);
  expect(next.read().cron.cronJobs).toEqual([job]);
  stopNext();
});
