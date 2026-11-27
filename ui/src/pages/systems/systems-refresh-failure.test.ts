/* @vitest-environment jsdom */
import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { setupSidebarTest } from "../../test-helpers/app-sidebar-setup.ts";
import {
  createContext,
  createSessions,
  createGatewayHarness,
} from "../../test-helpers/app-sidebar.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderSidebar, renderSolid } from "./systems-route-view.tsx";
import { createSystems } from "./systems-state.ts";
import { systemMeasurements } from "./systems-telemetry.ts";
import { systemInfo } from "./systems.test-support.ts";

setupSidebarTest();
afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it.each(["system.info", "node.list"])(
  "retires failed %s enrichment on inventory refresh while periodic failures stay last-known",
  async (method) => {
    const environments: EnvironmentSummary[] = [
      { id: "gateway", type: "local", platform: "darwin", status: "available" },
      { id: "node:desktop", type: "node", status: "available" },
    ];
    const nodes = [
      {
        nodeId: "desktop",
        connected: true,
        paired: true,
        platform: "macOS 27.0.0",
        hostStats: {
          cpuCount: 8,
          loadAverage: [2, 1, 1],
          memoryTotalBytes: 16 * 1024 ** 3,
          memoryFreeBytes: 8 * 1024 ** 3,
          updatedAtMs: Date.now(),
        },
      },
    ];
    let failing = false;
    const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
    vi.spyOn(client, "request").mockImplementation(async (called) => {
      if (failing && called === method) {
        throw new Error("Telemetry unavailable");
      }
      if (called === "environments.list") {
        return { environments };
      }
      if (called === "node.list") {
        return { nodes };
      }
      if (called === "system.info") {
        return { ...systemInfo, osLabel: "macOS 27.0.0" };
      }
      if (called === "backup.status") {
        return { targets: [], schedules: [], locations: [] };
      }
      throw new Error(`Unexpected request: ${called}`);
    });
    const { gateway } = createApplicationGateway(
      createApplicationGatewaySnapshot({
        client,
        phase: "connected",
        hello: gatewayHelloForMethods(
          ["environments.list", "node.list", "system.info"],
          ["operator.admin"],
        ),
      }),
    );
    const context = Object.assign(createContext(gateway, createSessions("main", [])), {
      router: createRouter({
        routes: [definePage({ id: "systems", path: "/systems", component: () => ({}) })],
      }),
    });
    const controller = createSystems(context);
    controller.setPresented(true);
    try {
      await vi.waitFor(() => {
        expect(controller.state.inventory?.gatewaySystemInfo).not.toBeNull();
        expect(controller.state.inventory?.nodes).toHaveLength(1);
      });
      const selectedId = method === "system.info" ? "gateway" : "node:desktop";
      const source = method === "system.info" ? "systemInfo" : "nodes";
      controller.select(selectedId);
      const previous = systemMeasurements(controller.selected()!);
      const healthyId = method === "system.info" ? "node:desktop" : "gateway";
      const healthy = systemMeasurements(
        controller.state.rows.find((row) => row.environment.id === healthyId)!,
      );
      expect(previous).toBeDefined();
      const history = controller.telemetryHistory(selectedId);

      failing = true;
      await controller.refreshTelemetry({ fresh: true });
      expect(controller.state.inventory?.errors[source]).toBe("Telemetry unavailable");
      expect(systemMeasurements(controller.selected()!)).toBe(previous);
      expect(controller.telemetryHistory(selectedId)).toBe(history);

      await controller.refresh("manual");
      await vi.waitFor(() => {
        expect(controller.state.inventory?.errors[source]).toBe("Telemetry unavailable");
        expect(systemMeasurements(controller.selected()!)).toBeUndefined();
      });
      expect(controller.state.rows.map((row) => row.environment)).toEqual(environments);
      expect(
        controller.state.inventory?.[method === "system.info" ? "gatewaySystemInfo" : "nodes"],
      ).toEqual(method === "system.info" ? null : []);
      expect(
        systemMeasurements(controller.state.rows.find((row) => row.environment.id === healthyId)!),
      ).toEqual(healthy);
    } finally {
      controller.setPresented(false);
    }
  },
);

it("keeps unknown inventory neutral without hiding offline recovery", async () => {
  const firstRead = createDeferred<EnvironmentSummary[]>();
  let inventory = () => firstRead.promise;
  const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method === "environments.list") {
      return { environments: await inventory() };
    }
    if (method === "system.info") {
      return systemInfo;
    }
    if (method === "node.list") {
      return { nodes: [] };
    }
    if (method === "backup.status") {
      return { targets: [], schedules: [], locations: [] };
    }
    throw new Error("Unexpected request: " + method);
  });
  const gateway = createGatewayHarness(client);
  gateway.publish({
    hello: gatewayHelloForMethods(
      ["environments.list", "system.info", "node.list"],
      ["operator.admin"],
    ),
  });
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  const context = Object.assign(createContext(gateway.gateway, createSessions("main", [])), {
    runtimeConfig,
    router: createRouter({
      routes: [definePage({ id: "systems", path: "/systems", component: () => ({}) })],
    }),
  });
  const controller = createSystems(context);
  try {
    const sidebar = renderSidebar({ controller })!;
    const data = { controller };
    const mounted = mountSolid(() => [
      createComponent(renderSolid, { data, presented: true, loaderPending: false }),
      sidebar,
    ]);
    const page = mounted.container.querySelector<HTMLElement>("openclaw-systems-page")!;
    const state = () => page.querySelector<HTMLElement>(".systems-desktop .systems-state")!;
    const heading = () => page.querySelector<HTMLElement>(".systems-heading")!;
    await waitForSolid(() => expect(state()).not.toBeNull());
    expect(state().style.visibility).toBe("hidden");
    firstRead.reject(new Error("Device inventory unavailable"));
    await waitForSolid(() =>
      expect(page.querySelector(".systems-callout--error")?.textContent).toContain(
        "Device inventory unavailable",
      ),
    );
    expect.soft(sidebar.querySelector(".systems-sidebar__empty")).toBeNull();
    expect.soft(state().style.visibility).toBe("hidden");
    expect.soft(heading().style.visibility).toBe("hidden");
    controller.updatePresentation({ query: "fleet" });
    flush();
    expect.soft(sidebar.querySelector(".systems-sidebar__empty")).toBeNull();
    gateway.publish({ phase: "reconnecting" });
    await waitForSolid(() => expect(state().style.visibility).not.toBe("hidden"));
    expect(state().textContent).toContain("Reconnect to refresh devices or open a desktop.");
    inventory = async () => [
      { id: "gateway", type: "local", label: "Gateway", status: "available" },
    ];
    gateway.publish({ phase: "connected" });
    await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
    await waitForSolid(() =>
      expect(sidebar.querySelector(".systems-sidebar__empty")?.textContent).toContain(
        "No devices match your search.",
      ),
    );
    expect(heading().style.visibility).not.toBe("hidden");
    controller.updatePresentation({ query: "" });
    await waitForSolid(() => expect(sidebar.querySelector(".systems-sidebar__empty")).toBeNull());
    expect(sidebar.textContent).toContain("Gateway");
  } finally {
    cleanupSolid();
    runtimeConfig.dispose();
  }
});
