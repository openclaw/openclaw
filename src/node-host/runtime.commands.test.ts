import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as plugins from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginNodeHostCommand } from "../plugins/types.node-host.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import type { NodeHostClient } from "./client.js";
import { startNodeHostConnection } from "./connection.js";
import { startNodeHostMcpManager } from "./mcp.js";
import { resetNodeHostPluginRegistry } from "./plugin-node-host.test-support.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { scanNodeHostedSkills } from "./skills.js";

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("./mcp.js", () => ({ startNodeHostMcpManager: vi.fn() }));
vi.mock("./skills.js", () => ({ scanNodeHostedSkills: vi.fn() }));
// mock-isolation: command admission uses only this test's in-memory plugin registry.
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: () => plugins.getActivePluginRegistry(),
}));

const hidden = {
  prepare: vi.fn(),
  watchAvailability: vi.fn(),
  computerUse: vi.fn(() => {
    throw new Error("hidden computer capability must not be read");
  }),
};
const read = vi.fn(async () => JSON.stringify({ items: [] }));
const makeCommand = (name: string, cap: string, extra: Partial<OpenClawPluginNodeHostCommand>) => ({
  pluginId: "fixture",
  source: "test",
  command: { command: name, cap, handle: read, ...extra },
});

beforeEach(() => {
  vi.clearAllMocks();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "fixture" }));
  registry.nodeHostCommands = [
    ...["fixture.list", "fixture.read"].map((name) =>
      makeCommand(name, "fixture-catalog", {
        agentTool: { name: "read", description: "Read" },
      }),
    ),
    makeCommand("computer.act", "computer", hidden),
  ];
  plugins.setActivePluginRegistry(registry);
});

afterEach(() => {
  resetNodeHostPluginRegistry();
  plugins.resetPluginRuntimeStateForTest();
});

it("publishes only selected commands and rejects hidden invokes without starting ancillary services", async () => {
  const platform = mockProcessPlatform("darwin");
  onTestFinished(() => platform.mockRestore());
  const prepared = await prepareNodeHostRuntime({
    config: { nodeHost: { workerRuns: { enabled: true } }, desktop: { host: { enabled: true } } },
    env: { PATH: "/private/host/bin" },
    enableAgentRuns: true,
    forceWorkerRuns: true,
    installedAppsSharingEnabled: true,
    commands: ["fixture.read", "fixture.list", "missing.command"],
  });
  expect(prepared.manifest).toEqual({
    caps: ["fixture-catalog"],
    commands: ["fixture.list", "fixture.read"],
  });
  expect(prepared.workerHostingEnabled).toBe(false);
  expect(prepared.initialInventory).toEqual({ skills: null, pluginTools: [] });
  const request = vi.fn(async () => ({}));
  const connection = startNodeHostConnection({
    prepared,
    client: { request } as unknown as NodeHostClient,
    onManifestChanged: vi.fn(),
    writeStderrLine: vi.fn(),
  });
  try {
    connection.connect({ url: "ws://127.0.0.1:19999", protocol: 4, capabilities: [] });
    expect(request).not.toHaveBeenCalled();
    expect(startNodeHostMcpManager).not.toHaveBeenCalled();
    expect(scanNodeHostedSkills).not.toHaveBeenCalled();
    for (const callback of Object.values(hidden)) {
      expect(callback).not.toHaveBeenCalled();
    }
    for (const command of [
      "system.run",
      "computer.act",
      "worker.launch.v1",
      "fs.listDir",
      "terminal.upload",
      "mcp.tools.call.v1",
      "fixture.read",
    ]) {
      await connection.invoke({ id: command, nodeId: "node", command });
      expect(request).toHaveBeenLastCalledWith(
        "node.invoke.result",
        expect.objectContaining({
          id: command,
          ok: command === "fixture.read",
          ...(command === "fixture.read"
            ? { payloadJSON: '{"items":[]}' }
            : { error: { code: "UNAVAILABLE", message: "command not advertised by this node" } }),
        }),
      );
    }
    expect(read).toHaveBeenCalledOnce();
  } finally {
    await connection.close();
  }
});

it("fails startup when the command allowlist is empty", async () => {
  await expect(prepareNodeHostRuntime({ config: {}, commands: [] })).rejects.toThrow(
    "empty allowlist",
  );
});
