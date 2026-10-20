import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";

const gatewayMocks = vi.hoisted(() => ({ callGatewayTool: vi.fn() }));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => gatewayMocks.callGatewayTool(...args),
}));

import type { NodeListNode } from "./nodes-utils.js";
import { listNodes, resolveNodeIdFromList, selectDefaultNodeFromList } from "./nodes-utils.js";

function node({ nodeId, ...overrides }: Partial<NodeListNode> & { nodeId: string }): NodeListNode {
  return { nodeId, caps: ["canvas"], connected: true, ...overrides };
}

function offline(nodeId: string, platform: string, connectedAtMs?: number, lastSeenAtMs?: number) {
  return node({ nodeId, platform, connected: false, connectedAtMs, lastSeenAtMs });
}

beforeEach(() => gatewayMocks.callGatewayTool.mockReset());

describe("resolveNodeIdFromList defaults", () => {
  it("selects a default in one comparison per remaining candidate", () => {
    const nodes = Array.from({ length: 512 }, (_, index) =>
      node({ nodeId: `node-${String((index * 197) % 512).padStart(4, "0")}`, connectedAtMs: 1 }),
    );
    const original = nodes.slice();
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      const selected = selectDefaultNodeFromList(nodes, { fallback: "first" });
      const comparisons = compare.mock.calls.length;
      expect(selected).toBe(nodes[0]);
      expect(nodes).toEqual(original);
      expect(comparisons).toBeLessThanOrEqual(nodes.length - 1);
    } finally {
      compare.mockRestore();
    }
  });

  it.each([
    {
      name: "connected candidates outrank offline recency",
      nodes: [
        offline("offline-phone", "ios", undefined, 5000),
        node({ nodeId: "online", platform: "android", connectedAtMs: 1000, lastSeenAtMs: 1000 }),
      ],
      expected: "online",
    },
    {
      name: "one local Mac outranks a more recently seen node",
      nodes: [
        node({ nodeId: "ios-1", platform: "ios", lastSeenAtMs: 5000 }),
        node({ nodeId: "mac-1", platform: "macos", lastSeenAtMs: 1000 }),
      ],
      expected: "mac-1",
    },
    {
      name: "offline candidates use lastSeenAtMs instead of connectedAtMs",
      nodes: [
        offline("abc123-desktop", "macos", 9000, 1000),
        offline("def456-phone", "ios", 1000, 5000),
      ],
      expected: "def456-phone",
    },
    {
      name: "offline candidates without lastSeenAtMs use stable nodeId ordering",
      nodes: [offline("z-node", "ios", 9000), offline("a-node", "android", 1000)],
      expected: "a-node",
    },
  ])("$name", ({ nodes, expected }) => {
    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe(expected);
  });
});

describe("listNodes", () => {
  it("strips node context support when the active Gateway does not advertise it", async () => {
    gatewayMocks.callGatewayTool.mockImplementation(
      async (_method, _opts, _params, extra: Pick<CallGatewayOptions, "onHelloOk">) => {
        extra.onHelloOk?.({
          type: "hello-ok",
          protocol: 1,
          server: { version: "test", connId: "test" },
          features: { methods: ["node.list"], events: [], capabilities: [] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 0,
          },
          auth: { role: "operator", scopes: [] },
          policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
        });
        return {
          nodes: [
            node({ nodeId: "updated-node", caps: ["system", "system.run.execution-context.v1"] }),
          ],
        };
      },
    );
    expect((await listNodes({}))[0]?.caps).toEqual(["system"]);
  });

  it("rethrows a closed Gateway transport without consulting paired nodes", async () => {
    const error = new Error("gateway closed (1008): unauthorized");
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(error).mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: "stale-node", displayName: "Stale Node" }],
    });

    const signal = new AbortController().signal;
    await expect(listNodes({}, signal)).rejects.toBe(error);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.list",
      {},
      {},
      expect.objectContaining({ signal }),
    );
  });
});
