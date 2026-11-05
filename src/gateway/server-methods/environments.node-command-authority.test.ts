import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EnvironmentsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { NodeRegistry } from "../node-registry.js";
import { makeClient } from "../node-registry.test-helpers.js";
import {
  createDevicePairingNodeSnapshot,
  invokeEnvironment as invoke,
  pairedNodeDevice,
} from "./environments.test-support.js";

const registries: NodeRegistry[] = [];
const command = "codex.exec-server.stdio.v1";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  for (const registry of registries.splice(0)) {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  }
  vi.restoreAllMocks();
});

vi.mock("../../infra/device-pairing-store-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/device-pairing-store-readonly.js")>()),
  readDevicePairingNodeSnapshot: vi.fn(),
}));

// mock-isolation: Fixed placement descriptors isolate command policy from runtime catalog state.
vi.mock("../worker-environments/placement-capabilities.js", () => ({
  resolveWorkerPlacementCapabilities: vi.fn((runtimeId: string) =>
    runtimeId === "codex"
      ? {
          executionMode: "remote-exec",
          devicePlacement: {
            requiredNodeCommands: [command],
            consumesWorkerSlot: false,
          },
        }
      : {},
  ),
}));

beforeEach(() => {
  const plugins = createEmptyPluginRegistry();
  plugins.nodeHostCommands.push({
    pluginId: "codex",
    source: "test/codex",
    command: {
      command,
      cap: "codex.exec-server",
      dangerous: true,
      handle: async () => "{}",
    },
  });
  setActivePluginRegistry(plugins);
});

it.each([
  [
    "invocable",
    ["system.which", command, "system.run", "system.run"],
    ["system.which", command, "system.run"],
    [command],
    ["system.run"],
    [command, "system.which"],
    false,
  ],
  ["pending-approval", [command], [], [command], [], [], false],
  ["unauthorized", [command, "fixture.unrelated"], [command], [], [], [], false],
  ["unauthorized", [command], [command], [command], [command], [], true],
  ["undeclared", [], [], [command], [], [], false],
] as const)(
  "projects %s for declarations %j approved %j with allow %j deny %j",
  async (state, declared, approved, allow, deny, expected, reload) => {
    const identity = { platform: "linux", clientId: "node-host" };
    const surface = { caps: ["session.host"], commands: [...approved] };
    vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(
      createDevicePairingNodeSnapshot([
        pairedNodeDevice("node-exec", surface, {
          ...identity,
          deviceFamily: "Linux",
          clientMode: "node",
        }),
      ]),
    );
    const commandPolicy = { allow: [...allow], deny: [...deny] };
    const initialPolicy = reload ? { allow: [command], deny: [] } : undefined;
    let config = { gateway: { nodes: { commands: initialPolicy ?? commandPolicy } } };
    const registry = new NodeRegistry({ getConfig: () => config });
    registries.push(registry);
    const client = makeClient("conn-exec", "node-exec", [], {
      ...identity,
      ...surface,
      declaredCommands: [...declared],
    });
    client.connect.client.deviceFamily = "Linux";
    const node = registry.register(client, { pairingIdentity: "node-exec" });
    if (initialPolicy) {
      // Reload the registered connection so withholding comes from its real policy owner.
      expect(node.commands).toEqual(approved);
      config = { gateway: { nodes: { commands: commandPolicy } } };
      registry.refreshRuntimePolicy(config);
    }
    vi.spyOn(registry, "listConnectedForPairingStates").mockReturnValue([node]);
    const context = {
      logGateway: { warn: vi.fn() },
      getRuntimeConfig: () => config,
      nodeRegistry: registry,
    };

    const [ok, result] = await invoke("environments.list", { runtimeId: "codex" }, context, {
      connect: { scopes: ["operator.write"] },
    });
    expect(ok).toBe(true);
    const payload: EnvironmentsListResult = result;
    const listed = payload.environments.find((environment) => environment.id === "node:node-exec");
    expect(listed?.invocableCommands ?? []).toEqual(expected);
    expect(listed?.requiredNodeCommand).toMatchObject({ command, state });
    const message = listed?.requiredNodeCommand?.message;
    if (state === "invocable") {
      expect(listed?.requiredNodeCommand).not.toHaveProperty("message");
    } else {
      const remediation =
        state === "pending-approval"
          ? "openclaw nodes approve <requestId>"
          : state === "unauthorized"
            ? "gateway.nodes.commands.deny"
            : "openclaw plugins enable codex";
      expect(message).toContain(remediation);
      if (state === "undeclared") {
        expect(message).not.toContain("gateway.nodes.commands.allow");
      }
    }
    for (const effectiveCommand of node.commands) {
      expect(listed?.capabilities).toContain(effectiveCommand);
    }

    const status = await invoke(
      "environments.status",
      { environmentId: "node:node-exec" },
      context,
    );
    const statusPayload = status[1] as { invocableCommands?: string[] } | undefined;
    expect(statusPayload?.invocableCommands ?? []).toEqual(expected);
  },
);

it("requires write scope for runtime-aware profile discovery", async () => {
  const params = { projection: "profiles" };
  const context = {
    logGateway: { warn: vi.fn() },
    getRuntimeConfig: () => ({}),
    nodeRegistry: new NodeRegistry(),
  };
  const readOnly = { connect: { scopes: ["operator.read"] } };
  expect(
    await invoke("environments.list", { ...params, runtimeId: "codex" }, context, readOnly),
  ).toEqual([
    false,
    undefined,
    expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.write" }),
  ]);

  expect((await invoke("environments.list", params, context, readOnly))[0]).toBe(true);
});
