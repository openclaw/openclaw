/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import type { SidebarAttentionStore } from "../app/sidebar-attention-store.ts";
import {
  createStore,
  cronPage,
  eventJob,
  inventoryRequest,
  startAuthenticatedStore,
} from "./sidebar-attention-store.test-support.ts";
import { SidebarAttentionStoreOwner } from "./sidebar-attention-store.ts";

function publish(
  harness: ReturnType<typeof createGatewayHarness>,
  action: string,
  job = eventJob(),
) {
  harness.emitEvent("cron", { action, jobId: job.id, job });
}

function calls(request: ReturnType<typeof inventoryRequest>, method = "cron.list") {
  return request.mock.calls.filter(([called]) => called === method).length;
}

describe("sidebar cron event publication", () => {
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

  it("updates Inbox attention through a minute of cron publications without inventory rereads", async () => {
    vi.useFakeTimers();
    let inventory = cronPage("incident");
    const request = inventoryRequest(() => inventory);
    const harness = startAuthenticatedStore(request);
    store = harness.attention;
    await vi.advanceTimersByTimeAsync(0);
    expect(store?.entries).toMatchObject([{ label: "incident" }]);
    const initialCalls = calls(request);

    for (let run = 1; run <= 23; run++) {
      publish(
        harness,
        "started",
        eventJob({ state: { runningAtMs: run * 2_000, lastRunStatus: "ok" } }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      publish(
        harness,
        "finished",
        eventJob({
          name: `Run ${run}`,
          state: { lastRunStatus: "error", lastRunAtMs: run * 2_000 },
        }),
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(14_000);
    expect(calls(request) - initialCalls).toBe(0);
    expect(calls(request, "cron.status")).toBe(1);
    expect(store?.entries).toMatchObject([{ label: "Run 23" }]);

    publish(harness, "removed");
    expect(store?.entries).toEqual([]);
    inventory = cronPage("new");
    publish(harness, "added", eventJob({ id: "new", name: "new" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store?.entries).toMatchObject([{ label: "new" }]);
    expect(calls(request)).toBe(initialCalls + 1);
  });

  it("does not restore a removed job when its in-flight run publishes a final snapshot", async () => {
    vi.useFakeTimers();
    let inventory = cronPage("incident");
    const request = inventoryRequest(() => inventory);
    const harness = startAuthenticatedStore(request);
    store = harness.attention;
    await vi.advanceTimersByTimeAsync(0);
    inventory = cronPage();
    publish(harness, "removed");
    expect(store?.entries).toEqual([]);
    publish(harness, "finished");
    expect(store?.entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store?.entries).toEqual([]);
    expect(calls(request)).toBe(2);
  });

  it.each([null, "main"])(
    "retains Gateway ownership of inventory membership for scope %s while applying held runtime facts",
    async (scopeId) => {
      vi.useFakeTimers();
      let inventory = cronPage("incident");
      const request = inventoryRequest(() => inventory);
      const harness = createGatewayHarness(mockClient(request));
      const selection = {
        state: { selectedId: "main", scopeId },
        intentRevision: 0,
        set: vi.fn(),
        setScope: vi.fn(),
        subscribe: () => () => undefined,
      } satisfies ApplicationContext["agentSelection"];
      store = createStore(harness.gateway, undefined, selection);
      store.activate(SidebarAttentionStoreOwner);
      await vi.advanceTimersByTimeAsync(0);

      publish(harness, "finished", eventJob({ agentId: undefined, name: "Inherited owner" }));
      expect(store.entries).toMatchObject([{ label: "Inherited owner" }]);
      expect(calls(request)).toBe(1);

      publish(harness, "added", eventJob({ id: "other", agentId: "writer" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.entries).toMatchObject([{ label: "incident" }]);
      expect(calls(request)).toBe(2);

      inventory = cronPage();
      publish(harness, "updated", eventJob({ agentId: "writer" }));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.entries).toEqual([]);
      expect(calls(request)).toBe(3);
    },
  );
});
