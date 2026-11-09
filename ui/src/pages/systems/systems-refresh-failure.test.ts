/* @vitest-environment jsdom */
import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createContext, createSessions } from "../../test-helpers/app-sidebar.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderSolid } from "./systems-route-view.tsx";
import { createSystems } from "./systems-state.ts";
import { systemMeasurements } from "./systems-telemetry.ts";
import { systemInfo } from "./systems.test-support.ts";

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

it("keeps a live Simulator capture through telemetry and inventory polls", async () => {
  const environments: EnvironmentSummary[] = [
    { id: "gateway", type: "local", status: "available" },
    { id: "node:sim", type: "node", status: "available", desktop: true },
  ];
  const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  let sequence = 0;
  const request = vi.spyOn(client, "request").mockImplementation(async (method, params) => {
    if (method === "environments.list") {
      return { environments };
    }
    if (method === "node.list") {
      return {
        nodes: [
          {
            nodeId: "sim",
            connected: true,
            paired: true,
            commands: ["simulator.capture", "simulator.act"],
          },
        ],
      };
    }
    if (method === "system.info") {
      return systemInfo;
    }
    if (method === "backup.status") {
      return { targets: [], schedules: [], locations: [] };
    }
    if (method === "node.invoke") {
      const action = (params as { params: { action: string } }).params.action;
      if (action === "stop") {
        return { payload: { ok: true } };
      }
      if (action === "type") {
        throw new Error("typed input refused");
      }
      if (action === "start") {
        return { payload: { sessionId: "session", sequence: 0, width: 402, height: 874 } };
      }
      return {
        payload: {
          sessionId: "session",
          sequence: ++sequence,
          jpegBase64: "AA==",
          width: 402,
          height: 874,
        },
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(
        ["environments.list", "node.list", "system.info", "node.invoke"],
        ["operator.admin"],
      ),
    }),
  );
  const context = Object.assign(createContext(gateway, createSessions("main", [])), {
    router: createRouter({
      routes: [definePage({ id: "systems", path: "/systems", component: () => ({}) })],
    }),
    runtimeConfig: createRuntimeConfigCapability(gateway),
  });
  const controller = createSystems(context);
  const mounted = mountSolid(() =>
    createComponent(renderSolid, { data: { controller }, presented: true, loaderPending: false }),
  );
  try {
    await waitForSolid(() => expect(controller.state.inventory).not.toBeNull());
    controller.select("node:sim");
    await waitForSolid(() =>
      expect(mounted.container.querySelector(".simulator-preview img")).not.toBeNull(),
    );
    const preview = mounted.container.querySelector(".simulator-preview");
    await controller.refreshTelemetry();
    await controller.refresh();
    flush();
    // The old capture effect restarted after its async stop completed, not during the poll.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(mounted.container.querySelector(".simulator-preview")).toBe(preview);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "node.invoke" &&
          (params as { params: { action: string } }).params.action === "start",
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "node.invoke" &&
          (params as { params: { action: string } }).params.action === "stop",
      ),
    ).toHaveLength(0);

    const input = mounted.container.querySelector<HTMLInputElement>(
      ".simulator-preview__text input",
    )!;
    input.value = "café";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(
      mounted.container.querySelector<HTMLButtonElement>(".simulator-preview__text button")
        ?.disabled,
    ).toBe(false);
    mounted.container.querySelector<HTMLButtonElement>(".simulator-preview__text button")!.click();
    await waitForSolid(() =>
      expect(mounted.container.textContent).toContain("typed input refused"),
    );
    mounted.container
      .querySelector<HTMLButtonElement>(".simulator-preview__header button")!
      .click();
    await waitForSolid(() =>
      expect(mounted.container.querySelector(".simulator-preview__text input")).not.toBeNull(),
    );
    const retryInput = mounted.container.querySelector<HTMLInputElement>(
      ".simulator-preview__text input",
    )!;
    expect(retryInput.value).toBe("café");
    retryInput.value = "漢".repeat(1366);
    retryInput.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    await waitForSolid(() =>
      expect(
        mounted.container.querySelector<HTMLButtonElement>(".simulator-preview__text button")
          ?.disabled,
      ).toBe(false),
    );
    mounted.container.querySelector<HTMLButtonElement>(".simulator-preview__text button")!.click();
    await waitForSolid(() =>
      expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain("4,096"),
    );
    expect(retryInput.value).toBe("漢".repeat(1366));
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "node.invoke" &&
          (params as { params: { action: string } }).params.action === "type",
      ),
    ).toHaveLength(1);
  } finally {
    mounted.unmount();
    context.runtimeConfig.dispose();
  }
});
