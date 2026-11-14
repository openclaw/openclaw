import { afterEach, expect, it, vi } from "vitest";
import * as computerAvailability from "../agents/computer-use-node-capabilities.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import * as gatewayContext from "../agents/tools/in-process-gateway.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { DevicePairingNodeSnapshot } from "../infra/device-pairing-read.types.js";
import * as pairingReads from "../infra/device-pairing-store-readonly.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import { readKnownNodeCatalog } from "./node-catalog-read.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";

const resolveTools = vi.hoisted(() => vi.fn());
// mock-isolation: Count cache-owned construction without loading optional plugin runtimes.
vi.mock("./tool-resolution.js", () => ({ resolveGatewayScopedTools: resolveTools }));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  let pairing: DevicePairingNodeSnapshot = { paired: [], bindings: new Map() };
  const registry = new NodeRegistry();
  let unknown = false;
  const reads = vi.fn();
  vi.spyOn(pairingReads, "readDevicePairingNodeSnapshot").mockImplementation(async () => {
    reads();
    if (unknown) {
      throw new Error("synthetic publication unavailable");
    }
    return pairing;
  });
  vi.spyOn(gatewayContext, "getInProcessGatewayToolContext").mockReturnValue(
    createGatewayRequestContext(makeContextParams({ nodeRegistry: registry })),
  );
  const projections = vi.spyOn(registry, "listConnectedForPairingStates");
  const execute = vi.fn(async () => ({ content: [], details: { fixture: true } }));
  const construct = async () => {
    const catalog = await readKnownNodeCatalog(registry).catch(() => undefined);
    const tool = { ...createStubTool("dir_list"), execute };
    setPluginToolMeta(tool, {
      pluginId: "fixture-node-owner",
      optional: false,
      listingSupported: catalog?.nodes.some((node) => node.commands?.includes("dir.list")),
    });
    return { agentId: "main", tools: [tool] };
  };
  resolveTools.mockReset().mockImplementation(construct);
  const publish = (commands = ["dir.list"]) => {
    pairing = {
      paired: [
        {
          deviceId: "fixture-node",
          publicKey: "synthetic-public-key",
          role: "node",
          roles: ["node"],
          platform: "linux",
          createdAtMs: 1,
          approvedAtMs: 2,
          nodeSurface: { commands, caps: [], createdAtMs: 1, approvedAtMs: 2 },
        },
      ],
      bindings: new Map([["fixture-node", { identity: "identity-a" }]]),
    };
  };
  const connect = () =>
    registerNodeSession(
      registry,
      makeClient("connection", "fixture-node", [], {
        platform: "linux",
        commands: ["dir.list"],
      }),
    );
  const params = {
    cfg: {},
    grantToken: "fixture-grant",
    context: {
      sessionKey: "agent:main:cache-publication",
      senderIsOwner: true,
      toolsAllow: ["dir_list"],
    },
  };
  return {
    registry,
    projections,
    execute,
    construct,
    publish,
    connect,
    params,
    reads,
    setUnknown: (value: boolean) => {
      unknown = value;
    },
  };
}

it.each(["early", "final"])(
  "refreshes the same %s cache entry after node publication",
  async (path) => {
    const f = fixture();
    if (path === "final") {
      f.params.context.toolsAllow.push("computer");
      vi.spyOn(
        computerAvailability,
        "loadPairedComputerUseAvailabilityForSurface",
      ).mockResolvedValue({ cacheKey: "unchanged-computer-surface" });
    }
    const cache = new McpLoopbackToolCache();
    const absent = await cache.resolve(f.params);
    expect(absent.tools).toEqual([]);
    expect(await cache.resolve(f.params)).toBe(absent);
    expect(resolveTools).toHaveBeenCalledTimes(path === "early" ? 1 : 2);
    expect(f.projections).toHaveBeenCalledTimes(1);
    f.publish();
    f.connect();
    try {
      const supported = await cache.resolve(f.params);
      expect(supported.toolSchema.map((tool) => tool.name)).toEqual(["dir_list"]);
      expect(await supported.tools[0]?.execute("fixture-call", {})).toMatchObject({
        details: { fixture: true },
      });
      expect(f.execute).toHaveBeenCalledOnce();
      expect(await cache.resolve(f.params)).toBe(supported);
      expect(resolveTools).toHaveBeenCalledTimes(path === "early" ? 2 : 4);
      expect(f.projections).toHaveBeenCalledTimes(2);
      f.registry.unregister("connection");
      const offline = await cache.resolve(f.params);
      expect(offline.toolSchema).toEqual(supported.toolSchema);
      expect(await cache.resolve(f.params)).toBe(offline);
      f.publish([]);
      const withdrawn = await cache.resolve(f.params);
      expect(withdrawn.tools).toEqual([]);
      expect(await cache.resolve(f.params)).toBe(withdrawn);
      expect(resolveTools).toHaveBeenCalledTimes(path === "early" ? 4 : 8);
      expect(f.projections).toHaveBeenCalledTimes(4);
    } finally {
      f.registry.unregister("connection");
    }
  },
);

it("does not publish tools from a node snapshot replaced during construction", async () => {
  const f = fixture();
  resolveTools.mockImplementationOnce(async () => {
    const beforePairing = await f.construct();
    f.publish();
    return beforePairing;
  });
  const cache = new McpLoopbackToolCache();
  const result = await cache.resolve(f.params);
  expect(result.toolSchema.map((tool) => tool.name)).toEqual(["dir_list"]);
  expect(await cache.resolve(f.params)).toBe(result);
  expect(resolveTools).toHaveBeenCalledTimes(2);
});

it("keeps unknown node publications conservative without inheriting an absent cached list", async () => {
  const f = fixture();
  const cache = new McpLoopbackToolCache();
  expect((await cache.resolve(f.params)).tools).toEqual([]);
  f.setUnknown(true);
  const unknown = await cache.resolve(f.params);
  expect(unknown.toolSchema.map((tool) => tool.name)).toEqual(["dir_list"]);
  expect(await cache.resolve(f.params)).toBe(unknown);
  f.setUnknown(false);
  expect((await cache.resolve(f.params)).tools).toEqual([]);
  expect(resolveTools).toHaveBeenCalledTimes(3);
  expect(f.projections).toHaveBeenCalledTimes(1);
});

it("retains cache revocation when a node-publication read yields before publication", async () => {
  const f = fixture();
  f.publish();
  const cache = new McpLoopbackToolCache();
  f.reads.mockImplementation(() => {
    if (f.reads.mock.calls.length === 3) {
      cache.clear();
    }
  });
  expect((await cache.resolve(f.params)).toolSchema.map((tool) => tool.name)).toEqual(["dir_list"]);
  expect(cache.evictGrant(f.params.grantToken)).toBe(false);
  await cache.resolve(f.params);
  expect(resolveTools).toHaveBeenCalledTimes(2);
});

it("refreshes authenticated MCP HTTP list and call through the same exact grant", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const f = fixture();
    const cfg = {
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg);
    const admission = mcp.prepareAdmission("node-cache-http", "node-cache-http", { cfg });
    try {
      await ensureMcpLoopbackServer();
      const listener = mcp.runtime();
      const grant = mcp.captureGrant(
        {
          runtimeOwnerToken: listener.ownerToken,
          admittedRunContext: await admission.admit("gateway"),
          toolPolicyConfig: cfg,
          context: { ...f.params.context, workspaceDir: state.workspaceDir },
        },
        "node-cache-http-capture",
      );
      const list = () =>
        mcp
          .request(listener, { jsonrpc: "2.0", id: 1, method: "tools/list" }, grant)
          .then(mcp.json);
      expect(await list()).toMatchObject({ result: { tools: [] } });
      expect(await list()).toMatchObject({ result: { tools: [] } });
      expect(resolveTools).toHaveBeenCalledOnce();
      f.publish();
      f.connect();
      const supported = await list();
      expect(supported).toMatchObject({
        result: { tools: [expect.objectContaining({ name: "dir_list" })] },
      });
      expect(
        await mcp.json(await mcp.request(listener, mcp.toolCall("dir_list", {}), grant)),
      ).toMatchObject({ result: { isError: false } });
      expect(resolveTools).toHaveBeenCalledTimes(2);
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.projections).toHaveBeenCalledTimes(2);
    } finally {
      f.registry.unregister("connection");
      await closeMcpLoopbackServer();
      admission.close();
    }
  });
});
