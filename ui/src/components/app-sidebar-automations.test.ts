/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
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
