/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";

it("keeps the Dashboards list only beside a dashboard opened from it", async () => {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const context = createContext(gateway.gateway, createSessionsHarness("main", []).sessions);
  const { sidebar } = await mountSidebarContext(context);
  const open = async (activeRouteId: string) => {
    sidebar.activeRouteId = activeRouteId;
    await sidebar.updateComplete;
    return sidebar.navigationView;
  };
  expect(await open("dashboards")).toBe("dashboards");
  // A dashboard opened from the list keeps the list beside it.
  expect(await open("chat")).toBe("dashboards");
  expect(await open("dashboards")).toBe("dashboards");
  // A page without a sidebar in between leaves a later chat with the Sessions list.
  await open("usage");
  expect(await open("chat")).toBe("sessions");
});
