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
    const initialCalls = request.mock.calls.filter(([method]) => method === "cron.list").length;

    for (let run = 1; run <= 23; run++) {
      harness.emitEvent("cron", {
        action: "started",
        jobId: "incident",
        job: eventJob({ state: { runningAtMs: run * 2_000, lastRunStatus: "ok" } }),
      });
      await vi.advanceTimersByTimeAsync(1_000);
      harness.emitEvent("cron", {
        action: "finished",
        jobId: "incident",
        job: eventJob({
          name: `Run ${run}`,
          state: { lastRunStatus: "error", lastRunAtMs: run * 2_000 },
        }),
      });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(14_000);
    expect(
      request.mock.calls.filter(([method]) => method === "cron.list").length - initialCalls,
    ).toBe(0);
    expect(request.mock.calls.filter(([method]) => method === "cron.status")).toHaveLength(1);
    expect(store?.entries).toMatchObject([{ label: "Run 23" }]);

    harness.emitEvent("cron", { action: "removed", jobId: "incident", job: eventJob() });
    expect(store?.entries).toEqual([]);
    inventory = cronPage("new");
    harness.emitEvent("cron", {
      action: "added",
      jobId: "new",
      job: eventJob({ id: "new", name: "new" }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store?.entries).toMatchObject([{ label: "new" }]);
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(
      initialCalls + 1,
    );
  });

  it("does not restore a removed job when its in-flight run publishes a final snapshot", async () => {
    vi.useFakeTimers();
    let inventory = cronPage("incident");
    const request = inventoryRequest(() => inventory);
    const harness = startAuthenticatedStore(request);
    store = harness.attention;
    await vi.advanceTimersByTimeAsync(0);
    inventory = cronPage();
    harness.emitEvent("cron", { action: "removed", jobId: "incident", job: eventJob() });
    expect(store?.entries).toEqual([]);
    harness.emitEvent("cron", { action: "finished", jobId: "incident", job: eventJob() });
    expect(store?.entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store?.entries).toEqual([]);
    expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2);
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

      harness.emitEvent("cron", {
        action: "finished",
        jobId: "incident",
        job: eventJob({ agentId: undefined, name: "Inherited owner" }),
      });
      expect(store.entries).toMatchObject([{ label: "Inherited owner" }]);
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(1);

      harness.emitEvent("cron", {
        action: "added",
        jobId: "other",
        job: eventJob({ id: "other", agentId: "writer" }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.entries).toMatchObject([{ label: "incident" }]);
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(2);

      inventory = cronPage();
      harness.emitEvent("cron", {
        action: "updated",
        jobId: "incident",
        job: eventJob({ agentId: "writer" }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.entries).toEqual([]);
      expect(request.mock.calls.filter(([method]) => method === "cron.list")).toHaveLength(3);
    },
  );
});
