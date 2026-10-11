// Node selection defaults and Gateway inventory requests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallGatewayOptions } from "../../gateway/call.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  inProcess: false,
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
  gatewayMocks.inProcess = false;
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

  it.each([undefined])(
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
  it.each([{ inProcess: false, gatewayCaps: [], expected: [] }])(
    "negotiates node context through the active Gateway %j",
    async ({ inProcess, gatewayCaps, expected }) => {
      gatewayMocks.inProcess = inProcess;
      gatewayMocks.callGatewayTool.mockImplementation(
        async (_method, _opts, _params, extra: Pick<CallGatewayOptions, "onHelloOk">) => {
          if (!inProcess) {
            extra.onHelloOk?.({
              type: "hello-ok",
              protocol: 1,
              server: { version: "test", connId: "test" },
              features: { methods: ["node.list"], events: [], capabilities: gatewayCaps },
              snapshot: {
                presence: [],
                health: {},
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 0,
              },
              auth: { role: "operator", scopes: [] },
              policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
            });
          }
          return {
            nodes: [
              node({ nodeId: "updated-node", caps: ["system", "system.run.execution-context.v1"] }),
            ],
          };
        },
      );
      expect((await listNodes({}))[0]?.caps).toEqual(["system", ...expected]);
    },
  );

  it.each([
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
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
      "node.list",
      {},
      {},
      expect.objectContaining({ signal }),
    );
  });
});
