/** Tests node-host capability discovery and inventory publication. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLoopReadyResult } from "../../packages/gateway-client/src/event-loop-ready.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import type { NodeHostMcpManager } from "./mcp.js";
import {
  expectStartupTimeout,
  lastCapturedOptions,
  mocks,
  receiveHello,
  resetRunnerTestState,
  runNodeHost,
  startNodeHostMcpManager,
  withReadyNodeHost,
} from "./runner.test-support.js";

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const nodeOptions = { gatewayHost: "127.0.0.1", gatewayPort: 18789 };
type CapturedClient = (typeof mocks.capturedGatewayClients)[number];

async function expectWorkerInventory(client: CapturedClient, workerHost: unknown, last = false) {
  const params = { protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE], workerHost };
  await vi.waitFor(() => {
    const request = expect(client.request);
    if (last) {
      request.toHaveBeenLastCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, params);
    } else {
      request.toHaveBeenCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, params);
    }
  });
}

describe("runNodeHost", () => {
  beforeEach(resetRunnerTestState);

  it("reconciles the manifest after watch attachment and on later changes", async () => {
    mocks.availabilityOnWatch = {
      caps: ["canvas"],
      commands: ["canvas.present"],
    };
    await withReadyNodeHost(async ({ client }) => {
      expect(client.updateNodeManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          caps: expect.arrayContaining(["canvas"]),
          commands: expect.arrayContaining(["canvas.present"]),
        }),
      );
      mocks.nodeHostCaps = [];
      mocks.nodeHostCommands = [];
      mocks.availabilityChanged?.();
      expect(client.updateNodeManifest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          caps: expect.not.arrayContaining(["canvas"]),
          commands: expect.not.arrayContaining(["canvas.present"]),
        }),
      );
    });
  });

  it("keeps unavailable worker hosting out of the handshake and reports the reason", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
      nodeHost: { workerRuns: { enabled: true } },
    });
    mocks.useFakeRuntime = true;
    mocks.fakeRuntimeWorkerHostingDisabledReason = "Docker or Podman is unavailable";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expectStartupTimeout();

    expect(lastCapturedOptions()?.workerRuns).toBeUndefined();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "node host worker hosting disabled: Docker or Podman is unavailable\n",
    );
    stderr.mockRestore();
  });

  it("advertises Claude agent runs only after node-local opt-in and binary resolution", async () => {
    mocks.resolvedExecutables.set("claude", "/usr/bin/claude");
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
      nodeHost: { agentRuns: { claude: { enabled: true } } },
    });

    await expectStartupTimeout();

    expect(lastCapturedOptions()?.commands).toContain("agent.cli.claude.run.v1");
  });

  it("publishes each exact worker slot transition without reconnecting", async () => {
    mocks.useFakeRuntime = true;
    mocks.fakeRuntimeWorkerHosting = true;
    await withReadyNodeHost(async ({ options, client }) => {
      expect(options.workerRuns).toBeUndefined();
      const workerHost = {
        enabled: true,
        capacity: { total: 2, available: 2 },
        bundlePrewarm: 1,
        bundleRetention: 1,
      };
      mocks.runnerCapacityChanged?.({ total: 2, available: 2 });
      receiveHello(options, 4, [GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION]);
      await expectWorkerInventory(client, workerHost);

      const negotiatedWorkerHost = {
        ...workerHost,
        bundleStatus: 1,
        portalStream: 1,
        environmentSession: 1,
      };
      receiveHello(options, 4, [
        GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION,
        GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_STATUS,
        GATEWAY_SERVER_CAPS.NODE_WORKER_PORTAL_STREAM,
        GATEWAY_SERVER_CAPS.NODE_WORKER_ENVIRONMENT_SESSION,
      ]);
      await expectWorkerInventory(client, negotiatedWorkerHost);

      for (const available of [1, 0, 2]) {
        mocks.runnerCapacityChanged?.({ total: 2, available });
        await expectWorkerInventory(
          client,
          { ...negotiatedWorkerHost, capacity: { total: 2, available } },
          true,
        );
      }
      expect(client.updateNodeManifest).not.toHaveBeenCalled();
    });
  });

  it("republishes current worker facts after this node's surface approval without cancelling invokes", async () => {
    mocks.useFakeRuntime = true;
    mocks.fakeRuntimeWorkerHosting = true;
    await withReadyNodeHost(async ({ options, client }) => {
      mocks.runnerCapacityChanged?.({ total: 2, available: 1 });
      receiveHello(options);
      await vi.waitFor(() =>
        expect(client.request).toHaveBeenCalledWith(
          NODE_RUNNER_INVENTORY_UPDATE_METHOD,
          expect.objectContaining({
            workerHost: expect.objectContaining({ capacity: { total: 2, available: 1 } }),
          }),
        ),
      );
      const publications = () =>
        client.request.mock.calls.filter(
          ([method]) => method === NODE_RUNNER_INVENTORY_UPDATE_METHOD,
        );
      const before = publications().length;
      const cancelsBefore = mocks.activeRuntime.cancelAll.mock.calls.length;
      for (const payload of [
        { nodeId: "another-node", decision: "approved" },
        { nodeId: "device-test", decision: "rejected" },
        { nodeId: "node-test", decision: "approved" },
      ]) {
        options.onEvent?.({ type: "event", event: "node.pair.resolved", payload });
      }
      await Promise.resolve();
      expect(publications()).toHaveLength(before);
      options.onEvent?.({
        type: "event",
        event: "node.pair.resolved",
        payload: { nodeId: "device-test", decision: "approved", requestId: "approval-1", ts: 1 },
      });
      await vi.waitFor(() => expect(publications()).toHaveLength(before + 1));
      expect(publications().at(-1)?.[1]).toMatchObject({
        workerHost: { enabled: true, capacity: { total: 2, available: 1 } },
      });
      expect(mocks.activeRuntime.cancelAll).toHaveBeenCalledTimes(cancelsBefore);
      expect(client.updateNodeManifest).not.toHaveBeenCalled();
    });
  });

  it("publishes plugin tools during MCP discovery and republishes catalog changes", async () => {
    const readiness = createDeferred<EventLoopReadyResult>();
    const manager = createDeferred<NodeHostMcpManager>();
    mocks.startGatewayClientWhenEventLoopReady.mockReturnValueOnce(readiness.promise);
    vi.mocked(startNodeHostMcpManager).mockImplementationOnce(async (_servers, deps) => {
      mocks.mcpDescriptorsChanged = deps?.onDescriptorsChanged;
      return await manager.promise;
    });
    const running = runNodeHost(nodeOptions);
    await vi.waitFor(() => expect(lastCapturedOptions()).toBeDefined());
    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
    receiveHello(lastCapturedOptions());
    expect(mocks.capturedGatewayClients[0]?.request).toHaveBeenCalledWith(
      "node.pluginTools.update",
      { tools: [expect.objectContaining({ pluginId: "test-plugin" })] },
    );

    const descriptors: NodeHostMcpManager["descriptors"] = ["closed", "healthy"].map((server) => ({
      pluginId: "node-mcp",
      name: `${server}_search`,
      description: `Search ${server} server`,
      command: "mcp.tools.call.v1",
      mcp: { server, tool: "search" },
    }));
    manager.resolve({
      descriptors,
      callMcpTool: vi.fn(),
      close: mocks.closeMcpManager,
    });
    const client = mocks.capturedGatewayClients[0];
    const publishedToolNames = () => {
      const params = client?.request.mock.calls.findLast(
        ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
      )?.[1] as { tools: Array<{ name?: string }> } | undefined;
      return params?.tools.map((descriptor) => descriptor.name);
    };
    await vi.waitFor(() => {
      expect(publishedToolNames()).toEqual(["closed_search", "healthy_search", "remote_echo"]);
    });

    descriptors.splice(0, 1);
    expect(mocks.mcpDescriptorsChanged).toBeDefined();
    mocks.mcpDescriptorsChanged?.();
    await vi.waitFor(() => {
      expect(publishedToolNames()).toEqual(["healthy_search", "remote_echo"]);
    });
    readiness.resolve({ ready: false, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 0 });
    await expect(running).rejects.toThrow("event loop readiness timeout");
  });
});
