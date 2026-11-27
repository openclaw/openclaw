/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { CronJob } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import {
  createStore,
  cronPage,
  eventJob,
  inventoryRequest,
} from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";

let store: SidebarAttentionStore | undefined;
afterEach(async () => {
  store?.dispose();
  store = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Inbox startup also starts a nested composer-storage import.
  await vi.dynamicImportSettled();
});

async function setup(selection?: ApplicationContext["agentSelection"]) {
  vi.useFakeTimers();
  let inventory = cronPage("incident");
  const request = inventoryRequest(() => inventory);
  const harness = createGatewayHarness(mockClient(request));
  if (!selection) {
    harness.update({ selfUser: { id: "alice", name: "Alice" } });
  }
  store = createStore(harness.gateway, undefined, selection);
  store.activate(SidebarAttentionStoreOwner);
  await vi.advanceTimersByTimeAsync(0);
  return {
    inventory(id?: string) {
      inventory = cronPage(id);
    },
    calls(method = "cron.list") {
      return request.mock.calls.filter(([called]) => called === method).length;
    },
    publish(action: string, overrides: Partial<CronJob> = {}) {
      const job = eventJob(overrides);
      harness.emitEvent("cron", { action, jobId: job.id, job });
    },
    changed() {
      harness.emitEvent("cron.inventory.changed", {});
    },
  };
}

it("updates the automation failure indicator through a minute of cron publications without inventory rereads", async () => {
  const h = await setup();
  expect(store?.hasFailedAutomation).toBe(true);
  const initialCalls = h.calls();
  for (let run = 1; run <= 23; run++) {
    h.publish("started", { state: { runningAtMs: run * 2_000, lastRunStatus: "ok" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store?.hasFailedAutomation).toBe(false);
    h.publish("finished", {
      state: { lastRunStatus: "error", lastRunAtMs: run * 2_000 },
    });
    await vi.advanceTimersByTimeAsync(1_000);
  }
  await vi.advanceTimersByTimeAsync(14_000);
  expect(h.calls() - initialCalls).toBe(0);
  expect(store?.hasFailedAutomation).toBe(true);
  h.publish("removed");
  expect(store?.hasFailedAutomation).toBe(false);
  h.inventory("new");
  h.publish("finished", { id: "new", name: "new" });
  expect(store?.hasFailedAutomation).toBe(false);
  h.changed();
  await vi.advanceTimersByTimeAsync(50);
  expect(store?.hasFailedAutomation).toBe(true);
  expect(h.calls()).toBe(initialCalls + 1);
});

it("does not restore a removed job when its in-flight run publishes a final snapshot", async () => {
  const h = await setup();
  h.inventory();
  h.publish("removed");
  expect(store?.hasFailedAutomation).toBe(false);
  h.publish("finished");
  expect(store?.hasFailedAutomation).toBe(false);
  h.changed();
  await vi.advanceTimersByTimeAsync(50);
  expect(store?.hasFailedAutomation).toBe(false);
  h.publish("finished");
  expect(store?.hasFailedAutomation).toBe(false);
  expect(h.calls()).toBe(2);
});

it.each([null, "main"])(
  "retains Gateway inventory membership for scope %s while applying held runtime facts",
  async (scopeId) => {
    const h = await setup({
      state: { selectedId: "main", scopeId },
      intentRevision: 0,
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe: () => () => undefined,
    });
    h.publish("finished", { agentId: undefined, name: "Inherited owner" });
    expect(store?.hasFailedAutomation).toBe(true);
    expect(h.calls()).toBe(1);
    h.publish("finished", { id: "other", agentId: "writer" });
    await vi.advanceTimersByTimeAsync(50);
    expect(store?.hasFailedAutomation).toBe(true);
    expect(h.calls()).toBe(1);
    h.inventory();
    h.changed();
    await vi.advanceTimersByTimeAsync(50);
    expect(store?.hasFailedAutomation).toBe(false);
    expect(h.calls()).toBe(2);
  },
);
