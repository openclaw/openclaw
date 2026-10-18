import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { readDevicePairingNodeSnapshot } from "../../infra/device-pairing-store-readonly.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { NodeRegistry } from "../node-registry.js";
import { environmentsHandlers } from "./environments.js";
import { createDevicePairingNodeSnapshot, pairedNodeDevice } from "./environments.test-support.js";

const registries: NodeRegistry[] = [];

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

vi.mock("../worker-environments/placement-capabilities.js", () => ({
  resolveWorkerPlacementCapabilities: vi.fn((runtimeId: string) =>
    runtimeId === "codex"
      ? {
          executionMode: "remote-exec",
          devicePlacement: {
            requiredNodeCommands: ["codex.exec-server.stdio.v1"],
            consumesWorkerSlot: false,
          },
        }
      : {},
  ),
}));

beforeEach(() => {
  vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(createDevicePairingNodeSnapshot([]));
  const plugins = createEmptyPluginRegistry();
  plugins.nodeHostCommands.push({
    pluginId: "codex",
    source: "test/codex",
    command: {
      command: "codex.exec-server.stdio.v1",
      cap: "codex.exec-server",
      dangerous: true,
      handle: async () => "{}",
    },
  });
  setActivePluginRegistry(plugins);
});

describe("node environment command authority", () => {
  const command = "codex.exec-server.stdio.v1";
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
      vi.mocked(readDevicePairingNodeSnapshot).mockResolvedValue(
        createDevicePairingNodeSnapshot([
          pairedNodeDevice(
            "node-exec",
            {
              displayName: "Execution Node",
              caps: ["session.host"],
              commands: [...approved],
            },
            {
              platform: "linux",
              deviceFamily: "Linux",
              clientId: "node-host",
              clientMode: "node",
            },
          ),
        ]),
      );
      const commandPolicy = { allow: [...allow], deny: [...deny] };
      const initialPolicy = reload ? { allow: [command], deny: [] } : undefined;
      let config = { gateway: { nodes: { commands: initialPolicy ?? commandPolicy } } };
      const registry = new NodeRegistry({ getConfig: () => config });
      registries.push(registry);
      const node = registry.register(
        {
          connId: "conn-exec",
          socket: { readyState: 1, bufferedAmount: 0, send: vi.fn() },
          connect: {
            client: {
              id: "node-host",
              mode: "node",
              displayName: "Execution Node",
              platform: "linux",
              deviceFamily: "Linux",
            },
            device: { id: "node-exec" },
            caps: ["session.host"],
            declaredCommands: [...declared],
            commands: [...approved],
          },
        } as never,
        { pairingIdentity: "node-exec" },
      );
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

      const listRespond = vi.fn();
      await environmentsHandlers["environments.list"]?.({
        params: { runtimeId: "codex" },
        respond: listRespond,
        client: { connect: { scopes: ["operator.write"] } },
        context,
      } as never);
      const payload: EnvironmentsListResult = listRespond.mock.calls[0]![1];
      const listed = payload.environments.find(
        (environment) => environment.id === "node:node-exec",
      );
      expect(listed?.invocableCommands ?? []).toEqual(expected);
      expect(listed?.requiredNodeCommand).toMatchObject({
        command: "codex.exec-server.stdio.v1",
        state,
      });
      if (state === "invocable") {
        expect(listed?.requiredNodeCommand).not.toHaveProperty("message");
      } else {
        const remediation =
          state === "pending-approval"
            ? "openclaw nodes approve <requestId>"
            : state === "unauthorized"
              ? "gateway.nodes.commands.deny"
              : "openclaw plugins enable codex";
        expect(listed?.requiredNodeCommand?.message).toContain(remediation);
        if (state === "undeclared") {
          expect(listed?.requiredNodeCommand?.message).toMatch(
            /^This model uses the Codex harness, which is unavailable on this device\./,
          );
          expect(listed?.requiredNodeCommand?.message).toContain("OpenClaw harness");
          expect(listed?.requiredNodeCommand?.message).toContain(
            "openclaw plugins install @openclaw/codex",
          );
          expect(listed?.requiredNodeCommand?.message).toContain("on that node");
          expect(listed?.requiredNodeCommand?.message).not.toContain(
            "gateway.nodes.commands.allow",
          );
        }
      }
      for (const effectiveCommand of node.commands) {
        expect(listed?.capabilities).toContain(effectiveCommand);
      }

      const statusRespond = vi.fn();
      await environmentsHandlers["environments.status"]?.({
        params: { environmentId: "node:node-exec" },
        respond: statusRespond,
        context,
      } as never);
      const statusPayload = statusRespond.mock.calls.at(0)?.[1] as
        | { invocableCommands?: string[] }
        | undefined;
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
    const readOnlyRespond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: { ...params, runtimeId: "codex" },
      respond: readOnlyRespond,
      client: { connect: { scopes: ["operator.read"] } },
      context,
    } as never);
    expect(readOnlyRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.write" }),
    );

    const inventoryRespond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params,
      respond: inventoryRespond,
      client: { connect: { scopes: ["operator.read"] } },
      context,
    } as never);
    expect(inventoryRespond.mock.calls.at(0)?.[0]).toBe(true);
  });
});
