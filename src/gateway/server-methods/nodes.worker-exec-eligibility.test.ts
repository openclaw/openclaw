import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import { projectPairedDeviceNodeBindings } from "../../infra/device-pairing-node-state.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { NODE_RUNNER_UPDATE_REQUIRED_ISSUE } from "../../infra/node-runner-inventory.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createNodeRegistryRuntime } from "../node-registry-private.js";
import { NodeRegistry } from "../node-registry.js";
import {
  createDevicePlacementAuthority,
  resolveDevicePlacementEligibility,
} from "../worker-environments/device-placement-eligibility.js";
import { selectDevicePlacementCandidates } from "../worker-environments/device-placement-selector.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
} from "../worker-environments/device-provider.js";
import { environmentsHandlers } from "./environments.js";
import { pairedNodeDevice } from "./environments.test-support.js";
import { nodeHandlers } from "./nodes.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing.js")>()),
  listDevicePairing: vi.fn(),
}));
vi.mock("../../infra/device-pairing-node-facts.js", () => ({
  updatePairedNodeSessionHost: vi.fn(async () => true),
}));

const CODEX_COMMAND = "codex.exec-server.stdio.v1";

it("scopes an outdated v6 host to OpenClaw and refreshes eligibility from current inventory", async () => {
  const previousRegistry = getActivePluginRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry(), "node-exec-eligibility-test", "default");
  registerAgentHarness({
    id: "codex",
    label: "Codex",
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: { requiredNodeCommands: [CODEX_COMMAND], consumesWorkerSlot: false },
    },
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("inventory must not run the harness");
    },
  });
  const paired = pairedNodeDevice("node-1", { commands: [CODEX_COMMAND] });
  vi.mocked(listDevicePairing).mockResolvedValue({ pending: [], paired: [paired] });
  const binding = expectDefined(
    projectPairedDeviceNodeBindings([paired]).get("node-1"),
    "paired node binding",
  );
  const runtime = createNodeRegistryRuntime(() => new NodeRegistry());
  const client = createWorkerSupervisorNodeClient();
  client.connect.commands = [CODEX_COMMAND];
  const register = () =>
    runtime.nodeRegistry.register(client, {
      pairingIdentity: binding.identity,
      pairingGeneration: binding.generation,
    });
  register();
  const config = { gateway: { nodes: { commands: { allow: [CODEX_COMMAND] } } } };
  const context = {
    nodeRegistry: runtime.nodeRegistry,
    getRuntimeConfig: () => config,
    logGateway: { warn: vi.fn() },
  };
  const environmentService = {};
  const devices = createDeviceWorkerRuntime({ getPairedDevice: async () => paired });
  devices.bindNodeTransport(runtime.nodeWorkerSupervisorTransport);
  bindDeviceWorkerAvailability(environmentService, devices.resolveAvailability);
  const isPlacementCurrent = createDevicePlacementAuthority(
    () => runtime.nodeWorkerSupervisorTransport,
  );
  const publish = async (capturedExecPolicy = false) => {
    const respond = vi.fn();
    await nodeHandlers["node.runnerInventory.update"]!({
      params: {
        protocolFeatures: ["node-worker-supervisor-v6"],
        workerHost: {
          enabled: true,
          capacity: { total: 2, available: 2 },
          ...(capturedExecPolicy ? { capturedExecPolicy: true } : {}),
        },
      },
      client,
      respond,
      context,
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, { nodeId: "node-1" }, undefined);
  };
  const inventory = async (runtimeId?: string) => {
    const respond = vi.fn();
    await environmentsHandlers["environments.list"]!({
      params: runtimeId ? { runtimeId } : {},
      client: { connect: { scopes: ["operator.write"] } },
      respond,
      context,
    } as unknown as GatewayRequestHandlerOptions);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    return (respond.mock.calls[0]![1] as { environments: EnvironmentSummary[] }).environments;
  };
  const select = async (runtimeId: string) =>
    await selectDevicePlacementCandidates({
      environments: await inventory(runtimeId),
      nodeRegistry: runtime.nodeRegistry,
      environmentService,
      runtimeId,
      executionMode: runtimeId === "openclaw" ? "worker-turn" : "remote-exec",
      config,
      requirement:
        runtimeId === "openclaw"
          ? { requiredNodeCommands: [], consumesWorkerSlot: true }
          : { requiredNodeCommands: [CODEX_COMMAND], consumesWorkerSlot: false },
    });
  try {
    await publish();
    const outdated = (await inventory("openclaw")).find((row) => row.id === "node:node-1");
    expect(outdated).toMatchObject({
      status: "available",
      sessionHost: true,
      issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE],
    });
    expect(await select("openclaw")).toMatchObject({
      ok: false,
      error: expect.stringContaining("run openclaw update, then reconnect"),
    });
    expect(
      await resolveDevicePlacementEligibility({
        environmentService,
        deviceId: "node-1",
        executionMode: "worker-turn",
        requirement: { requiredNodeCommands: [], consumesWorkerSlot: true },
        config,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("openclaw update") });
    for (const runtimeId of [undefined, "codex"]) {
      expect(
        (await inventory(runtimeId)).find((row) => row.id === "node:node-1"),
      ).not.toHaveProperty("issues");
    }
    expect(await select("codex")).toEqual({
      ok: true,
      candidates: [{ deviceId: "node-1", availableSlots: 2 }],
    });
    expect((await inventory("codex")).find((row) => row.id === "node:node-1")).toMatchObject({
      requiredNodeCommand: { command: CODEX_COMMAND, state: "invocable" },
    });

    await publish(true);
    const admitted = expectDefined(
      await runtime.nodeWorkerSupervisorTransport.getCurrentNode("node-1"),
      "current node proof",
    );
    const admittedRequirement = { requiredNodeCommands: [], consumesWorkerSlot: false };
    expect(isPlacementCurrent(admitted, admittedRequirement, "worker-turn")).toBe(true);
    expect(
      (await inventory("openclaw")).find((row) => row.id === "node:node-1"),
    ).not.toHaveProperty("issues");
    expect(await select("openclaw")).toEqual({
      ok: true,
      candidates: [{ deviceId: "node-1", availableSlots: 2 }],
    });
    await publish();
    expect(isPlacementCurrent(admitted, admittedRequirement, "worker-turn")).toBe(false);
    expect(runtime.nodeWorkerSupervisorTransport.isCurrent(admitted, false, [CODEX_COMMAND])).toBe(
      true,
    );
    expect(await select("openclaw")).toMatchObject({ ok: false });
    await publish(true);
    runtime.nodeRegistry.unregister(client.connId);
    client.connId = "replacement-connection";
    register();
    await publish();
    expect(await select("openclaw")).toMatchObject({ ok: false });
    expect(await select("codex")).toMatchObject({ ok: true });
  } finally {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry, "node-exec-eligibility-test-restore", "default");
    }
    runtime.nodeRegistry.unregister(client.connId);
  }
});
