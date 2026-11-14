/* @vitest-environment jsdom */
import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createContext, createSessions } from "../../test-helpers/app-sidebar.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createSystems } from "./systems-state.ts";
import { systemMeasurements } from "./systems-telemetry.ts";
import { systemInfo } from "./systems.test-support.ts";

afterEach(() => vi.restoreAllMocks());

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
