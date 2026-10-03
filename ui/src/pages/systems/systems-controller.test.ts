/* @vitest-environment jsdom */
import type { EnvironmentSummary } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createContext,
  createGatewayHarness,
  createSessionsHarness,
} from "../../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { SystemsController } from "./systems-controller.ts";

const environment: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway",
  status: "available",
};
const runtimeConfigs: ReturnType<typeof createRuntimeConfigCapability>[] = [];

afterEach(() => {
  for (const runtimeConfig of runtimeConfigs.splice(0)) {
    runtimeConfig.dispose();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness(inventory: () => Promise<EnvironmentSummary[]> = async () => [environment]) {
  const request = vi.fn(async (method: string) => {
    if (method === "environments.list") {
      return { environments: await inventory() };
    }
    if (method === "system.info") {
      return {};
    }
    if (method === "node.list") {
      return { nodes: [] };
    }
    if (method === "backup.status") {
      return { targets: [], schedules: [], locations: [] };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: gatewayHelloForMethods(
      ["environments.list", "node.list", "system.info"],
      ["operator.admin"],
    ),
  });
  const sessionsHarness = createSessionsHarness("main", []);
  const context = createContext(gateway.gateway, sessionsHarness.sessions);
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  runtimeConfigs.push(runtimeConfig);
  Object.assign(context, { runtimeConfig });
  const controller = new SystemsController(context);
  controller.setPresented(true);
  return { controller, gateway, request, sessionsHarness };
}

async function ready(controller: SystemsController) {
  await vi.waitFor(() => expect(controller.inventory).not.toBeNull());
}

function placementRow(generation: number): GatewaySessionRow {
  return {
    key: "agent:main:worker",
    sessionId: "worker",
    kind: "direct",
    updatedAt: generation,
    placement: {
      state: "reclaimed",
      generation,
      createdAtMs: 1,
      updatedAtMs: generation,
      stateChangedAtMs: generation,
      environmentId: "worker-one",
      activeOwnerEpoch: 1,
    },
  };
}

function publishPlacement(
  sessionsHarness: ReturnType<typeof createSessionsHarness>,
  generation: number,
) {
  sessionsHarness.publish({
    result: {
      ts: generation,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [placementRow(generation)],
    },
  });
}

it("paces worker placement invalidations and ignores unrelated session changes", async () => {
  const { controller, gateway, request } = harness();
  await ready(controller);

  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const inventoryReads = () =>
    request.mock.calls.filter(([method]) => method === "environments.list");
  gateway.publishEvent("sessions.changed", { reason: "activity-summary" });
  gateway.publishEvent("sessions.changed", { reason: "placement" });
  gateway.publishEvent("sessions.changed", { reason: "reclaim" });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(inventoryReads()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(inventoryReads()).toHaveLength(2);

  controller.setPresented(false);
});

it("coalesces placement snapshots and retains one trailing refresh during an inventory read", async () => {
  let inventory = async () => [environment];
  const { controller, request, sessionsHarness } = harness(() => inventory());
  await ready(controller);
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const inventoryReads = () =>
    request.mock.calls.filter(([method]) => method === "environments.list");

  publishPlacement(sessionsHarness, 1);
  publishPlacement(sessionsHarness, 2);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(inventoryReads()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(inventoryReads()).toHaveLength(2);

  const pending = createDeferred<EnvironmentSummary[]>();
  inventory = () => pending.promise;
  publishPlacement(sessionsHarness, 3);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(inventoryReads()).toHaveLength(3);
  publishPlacement(sessionsHarness, 4);
  inventory = async () => [environment];
  pending.resolve([environment]);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(inventoryReads()).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(inventoryReads()).toHaveLength(4);

  controller.setPresented(false);
});
