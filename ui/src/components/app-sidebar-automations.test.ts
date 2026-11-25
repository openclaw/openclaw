/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { sectionListsItems } from "../lib/section-navigation.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";

const inventory = vi.hoisted(() => ({
  read: vi.fn(async (_client: unknown, params: { offset?: number; limit?: number }) => {
    const total = 250;
    const offset = params.offset ?? 0;
    const next = Math.min(total, offset + (params.limit ?? 50));
    return {
      jobs: Array.from({ length: next - offset }, (_, index) => ({
        id: `job-${offset + index}`,
        name: `Automation ${String(offset + index).padStart(3, "0")}`,
        enabled: true,
        updatedAtMs: 0,
      })),
      total,
      offset,
      hasMore: next < total,
      nextOffset: next < total ? next : null,
    };
  }),
}));
vi.mock("../lib/cron/inventory.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/cron/inventory.ts")>()),
  readCronInventory: inventory.read,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

it("lists every automation, past the first page of the inventory", async () => {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ hello: gatewayHelloForMethods(["cron.list"]) });
  const context = createContext(gateway.gateway, createSessionsHarness("main", []).sessions);
  const { sidebar } = await mountSidebarContext(context);
  Object.assign(sidebar, { connected: true, navigationView: "automations" });
  await sidebar.updateComplete;
  await waitForSolid(() =>
    expect(sidebar.querySelectorAll(".sidebar-automations a[href*='?job=']")).toHaveLength(250),
  );
});

it("keeps a failed compact inventory reachable and retries its own read", async () => {
  inventory.read.mockRejectedValueOnce(new Error("Compact inventory unavailable"));
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ hello: gatewayHelloForMethods(["cron.list"]) });
  const context = createContext(gateway.gateway, createSessionsHarness("main", []).sessions);
  const { sidebar } = await mountSidebarContext(context);
  Object.assign(sidebar, { connected: true, navigationView: "automations" });
  await sidebar.updateComplete;
  await waitForSolid(() => expect(sidebar.textContent).toContain("Compact inventory unavailable"));
  expect(sectionListsItems("automations")).toBe(true);
  const reads = inventory.read.mock.calls.length;
  [...sidebar.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Retry")!
    .click();
  await waitForSolid(() =>
    expect(sidebar.querySelectorAll(".sidebar-automations a[href*='?job=']")).toHaveLength(250),
  );
  expect(inventory.read.mock.calls.length).toBeGreaterThan(reads);
  expect(sidebar.textContent).not.toContain("Compact inventory unavailable");
});

it("keeps its rows while the tab is hidden and reads again when it returns", async () => {
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ hello: gatewayHelloForMethods(["cron.list"]) });
  const context = createContext(gateway.gateway, createSessionsHarness("main", []).sessions);
  const { sidebar } = await mountSidebarContext(context);
  Object.assign(sidebar, { connected: true, navigationView: "automations" });
  await sidebar.updateComplete;
  const rows = () => sidebar.querySelectorAll(".sidebar-automations a[href*='?job=']");
  await waitForSolid(() => expect(rows()).toHaveLength(250));

  // A read in flight when the tab hides is abandoned by the inventory, as it does in production.
  const abandoned = Promise.withResolvers<never>();
  inventory.read.mockImplementationOnce(() => abandoned.promise);
  const reads = inventory.read.mock.calls.length;
  gateway.publishEvent("cron", {});
  await waitForSolid(() => expect(inventory.read).toHaveBeenCalledTimes(reads + 1));
  setVisibility("hidden");
  abandoned.reject(new DOMException("Cron inventory is no longer presented", "AbortError"));
  // Events while hidden do not read; the shown rows stay without an error.
  gateway.publishEvent("cron", {});
  await waitForSolid(() => expect(rows()).toHaveLength(250));
  expect(inventory.read).toHaveBeenCalledTimes(reads + 1);
  expect(sidebar.textContent).not.toContain("no longer presented");

  setVisibility("visible");
  await waitForSolid(() => expect(inventory.read.mock.calls.length).toBeGreaterThan(reads + 1));
  await waitForSolid(() => expect(rows()).toHaveLength(250));
  expect(sidebar.textContent).not.toContain("no longer presented");
});
