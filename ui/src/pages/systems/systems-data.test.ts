import type { EnvironmentSummary, SessionPlacement } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import {
  loadSystemsInventory,
  projectSystemsInventory,
  type SystemsInventory,
} from "./systems-data.ts";
import { systemInfo } from "./systems.test-support.ts";

afterEach(() => vi.restoreAllMocks());

const environments: EnvironmentSummary[] = [
  { id: "gateway", type: "local", status: "available" },
  { id: "node:headless", type: "node", status: "available", label: "Same name" },
  { id: "node:offline", type: "node", status: "unavailable", label: "Same name" },
  { id: "worker:active", type: "worker", status: "available", desktop: true },
  { id: "worker:retained", type: "worker", status: "unavailable" },
];
const inventory: SystemsInventory = {
  environments,
  nodes: [
    { nodeId: "headless", connected: true },
    { nodeId: "offline", connected: false },
    { nodeId: "managed-cloud-node", connected: true },
  ],
  gatewaySystemInfo: systemInfo,
  gatewaySampledAtMs: 1,
  errors: {},
};
const timing = { generation: 1, createdAtMs: 1, updatedAtMs: 2, stateChangedAtMs: 2 };
const active = createActiveSessionPlacement({ environmentId: "worker:active" });
function session(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: 1, ...fields };
}
function reclaimedPlacement(environmentId: string): SessionPlacement {
  return { state: "reclaimed", ...timing, environmentId };
}

it("omits completed worker history while keeping running workers and unresolved cleanup", () => {
  const states = ["attached", "destroying", "orphaned", "destroyed", "failed"] as const;
  const workers: EnvironmentSummary[] = states.map((state) => ({
    id: `worker:${state}`,
    type: "worker",
    status: state === "attached" ? "available" : "unavailable",
    worker: {
      state,
      providerId: "crabbox",
      ageMs: 1_000,
      attachedSessionIds: [],
      tunnelStatus: "stopped",
    },
  }));
  const rows = projectSystemsInventory({ ...inventory, environments: workers }, [
    session("archived", { placement: reclaimedPlacement("worker:destroyed"), archivedAt: 2 }),
  ]);
  expect(rows.map((row) => row.environment.id)).toEqual([
    "worker:attached",
    "worker:destroying",
    "worker:orphaned",
  ]);
});

it("uses placement before exec bindings and keeps offline runner identity", () => {
  const placed = session("placed", {
    execNode: "headless",
    placement: { ...active, runner: { kind: "device", deviceId: "offline", status: "offline" } },
  });
  const bound = session("bound", { execNode: "headless" });
  const local = session("local", { placement: { state: "local", ...timing } });
  const rows = projectSystemsInventory(inventory, [placed, bound, local]);
  expect(rows[0]?.sessions).toEqual([{ kind: "gateway", session: local }]);
  expect(rows[1]?.sessions).toEqual([{ kind: "exec-binding", session: bound }]);
  expect(rows[2]?.sessions).toEqual([{ kind: "runner", session: placed }]);
  expect(rows[3]?.sessions).toEqual([{ kind: "placement", session: placed }]);
});

it("retains only recorded terminal references and never guesses a prior device or Gateway fallback", () => {
  const reclaimed = session("reclaimed", {
    placement: reclaimedPlacement("worker:retained"),
    execNode: "headless",
  });
  const failed = session("failed", {
    placement: { state: "failed", ...timing, recoveryError: "Provisioning failed" },
  });
  const requested = session("requested", {
    placement: { state: "requested", ...timing },
    execNode: "headless",
  });
  const moved = session("moved", {
    placement: active,
    placementMove: { target: { kind: "device", deviceId: "headless" }, updatedAtMs: 2 },
  });
  const rows = projectSystemsInventory(inventory, [reclaimed, failed, requested, moved]);
  expect(rows[0]?.sessions).toEqual([]);
  expect(rows[1]?.sessions).toEqual([]);
  expect(rows[4]?.sessions).toEqual([{ kind: "retained-placement", session: reclaimed }]);
  expect(rows[3]?.sessions).toEqual([{ kind: "placement", session: moved }]);
});

function setup(...responses: unknown[]) {
  const client = new GatewayBrowserClient({ url: "ws://gateway.test" });
  const request = vi.spyOn(client, "request");
  for (const response of responses) {
    request.mockImplementationOnce(() =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
    );
  }
  const gateway = createApplicationGateway({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["system.info"]),
  } as ApplicationGatewaySnapshot).gateway;
  return { request, load: (signal?: AbortSignal) => loadSystemsInventory(gateway, { signal }) };
}

it("loads the existing read contracts and does not create a second session inventory", async () => {
  const { request, load } = setup({ environments }, { nodes: inventory.nodes }, systemInfo);
  const controller = new AbortController();
  expect(await load(controller.signal)).toEqual({
    ...inventory,
    gatewaySampledAtMs: expect.any(Number),
  });
  expect(
    request.mock.calls.map(([method, params, options]) => [method, params, options?.signal]),
  ).toEqual([
    ["environments.list", { includeDesktopSetup: true }, controller.signal],
    ["node.list", {}, controller.signal],
    ["system.info", {}, expect.any(AbortSignal)],
  ]);
});

it("keeps canonical inventory when auxiliary resource reads fail, with visible errors", async () => {
  const { load } = setup(
    { environments },
    new Error("Node inventory denied"),
    new Error("System info unavailable"),
  );
  expect(await load()).toMatchObject({
    environments,
    nodes: [],
    gatewaySystemInfo: null,
    errors: {
      nodes: expect.stringContaining("Node inventory denied"),
      systemInfo: expect.stringContaining("System info unavailable"),
    },
  });
});

it("propagates inventory failure rather than synthesizing a successful list from nodes", async () => {
  const failure = new Error("Inventory unavailable");
  const { load } = setup(failure, { nodes: inventory.nodes }, systemInfo);
  await expect(load()).rejects.toBe(failure);
});
