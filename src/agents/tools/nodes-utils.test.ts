// Node selection defaults and Gateway inventory requests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => gatewayMocks.callGatewayTool(...args),
}));

import type { NodeListNode } from "./nodes-utils.js";
import { listNodes, resolveNodeIdFromList, selectDefaultNodeFromList } from "./nodes-utils.js";

function node({ nodeId, ...overrides }: Partial<NodeListNode> & { nodeId: string }): NodeListNode {
  return {
    nodeId,
    caps: ["canvas"],
    connected: true,
    ...overrides,
  };
}

beforeEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
});

describe("resolveNodeIdFromList defaults", () => {
  it("selects a default in one comparison per remaining candidate", () => {
    const nodes = Array.from({ length: 512 }, (_, index) =>
      node({ nodeId: `node-${String((index * 197) % 512).padStart(4, "0")}`, connectedAtMs: 1 }),
    );
    const original = nodes.slice();
    const compare = vi.spyOn(String.prototype, "localeCompare");
    let selected: NodeListNode | null;
    let comparisons: number;
    try {
      selected = selectDefaultNodeFromList(nodes, { fallback: "first" });
      comparisons = compare.mock.calls.length;
    } finally {
      compare.mockRestore();
    }
    expect(selected).toBe(nodes[0]);
    expect(nodes).toEqual(original);
    expect(comparisons).toBeLessThanOrEqual(nodes.length - 1);
  });

  it("preserves the first equal-ranked object and skips sparse inventory holes", () => {
    const first = node({ nodeId: "same-node", connected: false, lastSeenAtMs: 5 });
    const second = { ...first, displayName: "second record" };
    const nodes: NodeListNode[] = [];
    nodes[3] = first;
    nodes[7] = second;
    const original = nodes.slice();

    expect(selectDefaultNodeFromList(nodes, { fallback: "first" })).toBe(first);
    expect(nodes).toEqual(original);
    expect(0 in nodes).toBe(false);
  });

  it("keeps compact display-name matching opt-in", () => {
    const nodes = [node({ nodeId: "mac-1", displayName: "Mac Studio" })];

    expect(() => resolveNodeIdFromList(nodes, "MacStudio")).toThrow(/unknown node: MacStudio/);
    expect(
      resolveNodeIdFromList(nodes, "MacStudio", false, { allowCompactDisplayName: true }),
    ).toBe("mac-1");
  });

  it("falls back to most recently connected node when multiple non-Mac candidates exist", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios", connectedAtMs: 1, lastSeenAtMs: 5000 }),
      node({ nodeId: "android-1", platform: "android", connectedAtMs: 2, lastSeenAtMs: 1000 }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("android-1");
  });

  it("ignores offline recency when any eligible node is connected", () => {
    const nodes: NodeListNode[] = [
      node({
        nodeId: "offline-phone",
        platform: "ios",
        connected: false,
        lastSeenAtMs: 5000,
      }),
      node({
        nodeId: "connected-desktop",
        platform: "android",
        connected: true,
        connectedAtMs: 1000,
        lastSeenAtMs: 1000,
      }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("connected-desktop");
  });

  it("preserves local Mac preference when exactly one local Mac candidate exists", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios", lastSeenAtMs: 5000 }),
      node({ nodeId: "mac-1", platform: "macos", lastSeenAtMs: 1000 }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("mac-1");
  });

  it("prefers most recently seen node when all candidates are disconnected", () => {
    const nodes: NodeListNode[] = [
      node({
        nodeId: "abc123-desktop",
        platform: "macos",
        connected: false,
        connectedAtMs: 9000,
        lastSeenAtMs: 1000,
      }),
      node({
        nodeId: "def456-phone",
        platform: "ios",
        connected: false,
        connectedAtMs: 1000,
        lastSeenAtMs: 5000,
      }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("def456-phone");
  });

  it("prefers node with lastSeenAtMs over node without when all disconnected", () => {
    const nodes: NodeListNode[] = [
      node({
        nodeId: "abc-no-seen",
        platform: "ios",
        connected: false,
        connectedAtMs: 9000,
      }),
      node({
        nodeId: "def-has-seen",
        platform: "android",
        connected: false,
        connectedAtMs: 1000,
        lastSeenAtMs: 3000,
      }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("def-has-seen");
  });

  it.each([undefined, 3000])(
    "uses stable nodeId ordering when disconnected-node lastSeenAtMs ties at %s",
    (lastSeenAtMs) => {
      // Deterministic tie-breaking keeps repeated wake attempts on one target.
      const nodes: NodeListNode[] = [
        node({
          nodeId: "z-node",
          platform: "ios",
          connected: false,
          connectedAtMs: 9000,
          lastSeenAtMs,
        }),
        node({
          nodeId: "a-node",
          platform: "android",
          connected: false,
          connectedAtMs: 1000,
          lastSeenAtMs,
        }),
      ];

      expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("a-node");
    },
  );
});

describe("listNodes", () => {
  it("returns live node inventory and forwards cancellation", async () => {
    const nodes = [node({ nodeId: "node-1", displayName: "Node 1", platform: "ios" })];
    gatewayMocks.callGatewayTool.mockResolvedValueOnce({ nodes });
    const signal = new AbortController().signal;
    await expect(listNodes({}, signal)).resolves.toEqual(nodes);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledExactlyOnceWith(
      "node.list",
      {},
      {},
      { signal },
    );
  });

  it.each([
    {
      label: "an unknown-method rejection",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list",
      }),
    },
    {
      label: "a closed Gateway transport",
      error: new Error("gateway closed (1008): unauthorized"),
    },
  ])("rethrows $label without consulting paired nodes", async ({ error }) => {
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(error).mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: "stale-node", displayName: "Stale Node" }],
    });

    const signal = new AbortController().signal;
    await expect(listNodes({}, signal)).rejects.toBe(error);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith("node.list", {}, {}, { signal });
  });
});
