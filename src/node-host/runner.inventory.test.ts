import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventLoopReadyResult } from "../../packages/gateway-client/src/event-loop-ready.js";
import { GATEWAY_SERVER_CAPS as CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD as INVENTORY,
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

type Client = (typeof mocks.capturedGatewayClients)[number];
const publications = (client: Client, method = INVENTORY) =>
  client.request.mock.calls.filter(([called]) => called === method);
const expectInventory = (client: Client, workerHost: unknown) =>
  vi.waitFor(() =>
    expect(publications(client).at(-1)?.[1]).toEqual({
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost,
    }),
  );
beforeEach(resetRunnerTestState);

describe("MSIX isolated desktop diagnostics", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    vi.stubEnv("CLAWCTL_GATEWAY_ISOLATION", "enabled");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["computer.act", "screen.snapshot"])(
    "warns on stderr without changing the advertised %s command or successful connection",
    async (command) => {
      mocks.nodeHostCommands = [command];
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await withReadyNodeHost(
        async ({ options, running }) => {
          expect(options.commands).toContain(command);
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining("isolated agent desktop, not your signed-in Windows desktop"),
          );
          expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Windows Hub"));
          expect(stderr).toHaveBeenCalledWith(
            expect.stringContaining(
              "computer.act support is pending: https://github.com/openclaw/openclaw-windows-node/issues/1871",
            ),
          );
          expect(stdout).not.toHaveBeenCalled();
          receiveHello(options);
          await expect(running).resolves.toEqual({ connected: true });
          expect(process.exitCode).toBe(0);
        },
        { stopAfterFirstConnect: true },
      );
    },
  );

  it.each([
    { platform: "win32", isolation: undefined, commands: ["computer.act"] },
    { platform: "linux", isolation: "enabled", commands: ["computer.act"] },
    { platform: "win32", isolation: "enabled", commands: ["system.which"] },
  ] as const)("does not warn for an unaffected node (%j)", async (scenario) => {
    Object.defineProperty(process, "platform", { ...platform, value: scenario.platform });
    vi.stubEnv("CLAWCTL_GATEWAY_ISOLATION", scenario.isolation);
    mocks.nodeHostCommands = [...scenario.commands];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expectStartupTimeout();
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Windows Hub"));
    expect(lastCapturedOptions()?.commands).toEqual(expect.arrayContaining(scenario.commands));
  });

  it("uses the filtered manifest rather than available plugin capabilities", async () => {
    mocks.nodeHostCaps = ["computer", "screen"];
    mocks.nodeHostCommands = ["computer.act", "screen.snapshot"];
    mocks.configureNodeHost.mockResolvedValueOnce({
      version: 1,
      nodeId: "restricted-node",
      commands: ["system.which"],
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expectStartupTimeout();
    expect(lastCapturedOptions()?.commands).toEqual(["system.which"]);
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Windows Hub"));
  });

  it("warns once when desktop commands become available after startup", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await withReadyNodeHost(async ({ client }) => {
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("Windows Hub"));
      mocks.nodeHostCommands = ["screen.snapshot"];
      mocks.availabilityChanged?.();
      expect(client.updateNodeManifest).toHaveBeenLastCalledWith(
        expect.objectContaining({ commands: expect.arrayContaining(["screen.snapshot"]) }),
      );
      mocks.nodeHostCommands = ["computer.act", "screen.snapshot"];
      mocks.availabilityChanged?.();
      const warnings = stderr.mock.calls.filter(([line]) => String(line).includes("Windows Hub"));
      expect(warnings).toHaveLength(1);
    });
  });
});

it("reconciles the manifest after watch attachment and on later changes", async () => {
  mocks.availabilityOnWatch = { caps: ["canvas"], commands: ["canvas.present"] };
  await withReadyNodeHost(async ({ client }) => {
    const check = (present: boolean) => {
      const contains = (values: string[]) =>
        present ? expect.arrayContaining(values) : expect.not.arrayContaining(values);
      expect(client.updateNodeManifest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          caps: contains(["canvas"]),
          commands: contains(["canvas.present"]),
        }),
      );
    };
    check(true);
    mocks.nodeHostCaps = [];
    mocks.nodeHostCommands = [];
    mocks.availabilityChanged?.();
    check(false);
  });
});

it("keeps unavailable worker hosting out of the handshake and reports the reason", async () => {
  mocks.getRuntimeConfig.mockReturnValue({
    gateway: { handshakeTimeoutMs: 1_000 },
    nodeHost: { workerRuns: { enabled: true } },
  });
  mocks.useFakeRuntime = true;
  const reason = "Docker or Podman is unavailable";
  mocks.fakeRuntimeWorkerHostingDisabledReason = reason;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await expectStartupTimeout();
  expect(lastCapturedOptions()?.workerRuns).toBeUndefined();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(reason));
  stderr.mockRestore();
});

it("advertises Claude agent runs after node-local opt-in and binary resolution", async () => {
  mocks.resolvedExecutables.set("claude", "/usr/bin/claude");
  mocks.getRuntimeConfig.mockReturnValue({
    gateway: { handshakeTimeoutMs: 1_000 },
    nodeHost: { agentRuns: { claude: { enabled: true } } },
  });
  await expectStartupTimeout();
  expect(lastCapturedOptions()?.commands).toContain("agent.cli.claude.run.v1");
  expect(lastCapturedOptions()?.caps).toContain("claude-cli-native-auth-v1");
});

it("publishes negotiated worker slots without reconnecting", async () => {
  mocks.useFakeRuntime = mocks.fakeRuntimeWorkerHosting = true;
  await withReadyNodeHost(async ({ options, client }) => {
    expect(options.workerRuns).toBeUndefined();
    const capacity = { total: 2, available: 2 };
    const workerHost = { enabled: true, capacity, bundlePrewarm: 1, bundleRetention: 1 };
    mocks.runnerCapacityChanged?.(capacity);
    receiveHello(options, 4, [CAPS.NODE_WORKER_BUNDLE_RETENTION]);
    await expectInventory(client, workerHost);
    const negotiated = { ...workerHost, bundleStatus: 1, portalStream: 1, environmentSession: 1 };
    receiveHello(options, 4, [
      CAPS.NODE_WORKER_BUNDLE_RETENTION,
      CAPS.NODE_WORKER_BUNDLE_STATUS,
      CAPS.NODE_WORKER_PORTAL_STREAM,
      CAPS.NODE_WORKER_ENVIRONMENT_SESSION,
    ]);
    await expectInventory(client, negotiated);
    for (const available of [1, 0, 2]) {
      mocks.runnerCapacityChanged?.({ total: 2, available });
      await expectInventory(client, { ...negotiated, capacity: { total: 2, available } });
    }
    expect(client.updateNodeManifest).not.toHaveBeenCalled();
  });
});

it("republishes only this node's approved surface without cancelling invokes", async () => {
  mocks.useFakeRuntime = mocks.fakeRuntimeWorkerHosting = true;
  await withReadyNodeHost(async ({ options, client }) => {
    mocks.runnerCapacityChanged?.({ total: 2, available: 1 });
    receiveHello(options);
    const expected = expect.objectContaining({
      workerHost: expect.objectContaining({ capacity: { total: 2, available: 1 } }),
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(INVENTORY, expected));
    const before = publications(client).length;
    const cancelsBefore = mocks.activeRuntime.cancelAll.mock.calls.length;
    const pair = (nodeId: string, decision: string) =>
      options.onEvent?.({
        type: "event",
        event: "node.pair.resolved",
        payload: { nodeId, decision },
      });
    pair("another-node", "approved");
    pair("device-test", "rejected");
    pair("node-test", "approved");
    await Promise.resolve();
    expect(publications(client)).toHaveLength(before);
    pair("device-test", "approved");
    await vi.waitFor(() => expect(publications(client)).toHaveLength(before + 1));
    expect(publications(client).at(-1)?.[1]).toMatchObject({
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
  const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
  await vi.waitFor(() => expect(lastCapturedOptions()).toBeDefined());
  const client = mocks.capturedGatewayClients[0]!;
  expect(client.request).not.toHaveBeenCalled();
  receiveHello(lastCapturedOptions());
  expect(client.request).toHaveBeenCalledWith("node.pluginTools.update", {
    tools: [expect.objectContaining({ pluginId: "test-plugin" })],
  });
  const descriptors: NodeHostMcpManager["descriptors"] = ["closed", "healthy"].map((server) => ({
    pluginId: "node-mcp",
    name: server + "_search",
    description: "Search " + server,
    command: "mcp.tools.call.v1",
    mcp: { server, tool: "search" },
  }));
  manager.resolve({ descriptors, callMcpTool: vi.fn(), close: mocks.closeMcpManager });
  const expectTools = (names: string[]) =>
    vi.waitFor(() => {
      const params = publications(client, "node.pluginTools.update").at(-1)?.[1] as
        | { tools: Array<{ name?: string }> }
        | undefined;
      expect(params?.tools.map(({ name }) => name)).toEqual(names);
    });
  await expectTools(["closed_search", "healthy_search", "remote_echo"]);
  descriptors.splice(0, 1);
  expect(mocks.mcpDescriptorsChanged).toBeDefined();
  mocks.mcpDescriptorsChanged?.();
  await expectTools(["healthy_search", "remote_echo"]);
  readiness.resolve({ ready: false, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 0 });
  await expect(running).rejects.toThrow("event loop readiness timeout");
});
