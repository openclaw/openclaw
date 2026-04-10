// Octopus Orchestrator — `openclaw octo node list/show` tests (M4-08)
//
// Covers:
//   - gatherNodeList / gatherNodeShow: data extraction from mock registry
//   - formatNodeList / formatNodeShow: human-readable output, empty state
//   - formatNodeListJson / formatNodeShowJson: valid JSON round-trip
//   - runNodeList: exit 0 always (empty + populated), json mode
//   - runNodeShow: exit 0 on found, exit 1 on unknown node, json mode

import { describe, expect, it, vi } from "vitest";
import type { NodeDetail, NodeRegistryView, NodeSummary } from "./node.ts";
import {
  formatNodeList,
  formatNodeListJson,
  formatNodeShow,
  formatNodeShowJson,
  gatherNodeList,
  gatherNodeShow,
  runNodeList,
  runNodeShow,
} from "./node.ts";

// ──────────────────────────────────────────────────────────────────────────
// Mock registry
// ──────────────────────────────────────────────────────────────────────────

function makeMockRegistry(nodes: NodeDetail[]): NodeRegistryView {
  return {
    listNodes(): NodeSummary[] {
      return nodes.map(({ nodeId, capabilities, activeArms, connected }) => ({
        nodeId,
        capabilities,
        activeArms,
        connected,
      }));
    },
    getNode(nodeId: string): NodeDetail | null {
      return nodes.find((n) => n.nodeId === nodeId) ?? null;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const NODE_A: NodeDetail = {
  nodeId: "node-alpha",
  capabilities: ["code-edit", "shell"],
  activeArms: 3,
  connected: true,
  maxArms: 8,
  lastTelemetryTs: 1700000000000,
  leaseCount: 2,
};

const NODE_B: NodeDetail = {
  nodeId: "node-beta",
  capabilities: [],
  activeArms: 0,
  connected: false,
  maxArms: 4,
  lastTelemetryTs: 0,
  leaseCount: 0,
};

// ════════════════════════════════════════════════════════════════════════
// gatherNodeList
// ════════════════════════════════════════════════════════════════════════

describe("gatherNodeList", () => {
  it("returns empty array for empty registry", () => {
    const reg = makeMockRegistry([]);
    expect(gatherNodeList(reg)).toEqual([]);
  });

  it("returns summaries for populated registry", () => {
    const reg = makeMockRegistry([NODE_A, NODE_B]);
    const nodes = gatherNodeList(reg);

    expect(nodes).toHaveLength(2);
    expect(nodes[0].nodeId).toBe("node-alpha");
    expect(nodes[0].activeArms).toBe(3);
    expect(nodes[1].nodeId).toBe("node-beta");
    expect(nodes[1].connected).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// gatherNodeShow
// ════════════════════════════════════════════════════════════════════════

describe("gatherNodeShow", () => {
  it("returns detail for known node", () => {
    const reg = makeMockRegistry([NODE_A]);
    const detail = gatherNodeShow(reg, "node-alpha");

    expect(detail).not.toBeNull();
    expect(detail!.maxArms).toBe(8);
    expect(detail!.leaseCount).toBe(2);
  });

  it("returns null for unknown node", () => {
    const reg = makeMockRegistry([NODE_A]);
    expect(gatherNodeShow(reg, "no-such-node")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatNodeList
// ════════════════════════════════════════════════════════════════════════

describe("formatNodeList", () => {
  it("shows 'No connected nodes.' for empty list", () => {
    const output = formatNodeList([]);
    expect(output).toContain("No connected nodes.");
  });

  it("lists nodes with status and arms", () => {
    const summaries: NodeSummary[] = [
      { nodeId: "node-alpha", capabilities: ["code-edit"], activeArms: 3, connected: true },
      { nodeId: "node-beta", capabilities: [], activeArms: 0, connected: false },
    ];
    const output = formatNodeList(summaries);

    expect(output).toContain("node-alpha");
    expect(output).toContain("connected");
    expect(output).toContain("arms=3");
    expect(output).toContain("node-beta");
    expect(output).toContain("disconnected");
  });
});

// ════════════════════════════════════════════════════════════════════════
// formatNodeShow
// ════════════════════════════════════════════════════════════════════════

describe("formatNodeShow", () => {
  it("renders detail fields", () => {
    const output = formatNodeShow(NODE_A);

    expect(output).toContain("Node: node-alpha");
    expect(output).toContain("connected");
    expect(output).toContain("Active arms:     3");
    expect(output).toContain("Max arms:        8");
    expect(output).toContain("Lease count:     2");
    expect(output).toContain("code-edit, shell");
  });
});

// ════════════════════════════════════════════════════════════════════════
// JSON formatters
// ════════════════════════════════════════════════════════════════════════

describe("formatNodeListJson", () => {
  it("produces valid JSON that round-trips", () => {
    const summaries: NodeSummary[] = [
      { nodeId: "node-alpha", capabilities: ["code-edit"], activeArms: 3, connected: true },
    ];
    const json = formatNodeListJson(summaries);
    const parsed = JSON.parse(json) as NodeSummary[];
    expect(parsed).toEqual(summaries);
  });
});

describe("formatNodeShowJson", () => {
  it("produces valid JSON that round-trips", () => {
    const json = formatNodeShowJson(NODE_A);
    const parsed = JSON.parse(json) as NodeDetail;
    expect(parsed).toEqual(NODE_A);
  });
});

// ════════════════════════════════════════════════════════════════════════
// runNodeList
// ════════════════════════════════════════════════════════════════════════

describe("runNodeList", () => {
  it("returns 0 on empty registry", () => {
    const reg = makeMockRegistry([]);
    const out = { write: vi.fn() };
    const code = runNodeList(reg, {}, out);

    expect(code).toBe(0);
    expect(out.write).toHaveBeenCalledTimes(1);
    const written = out.write.mock.calls[0][0] as string;
    expect(written).toContain("No connected nodes.");
  });

  it("returns 0 on populated registry", () => {
    const reg = makeMockRegistry([NODE_A, NODE_B]);
    const out = { write: vi.fn() };
    const code = runNodeList(reg, {}, out);

    expect(code).toBe(0);
    const written = out.write.mock.calls[0][0] as string;
    expect(written).toContain("node-alpha");
    expect(written).toContain("node-beta");
  });

  it("with json: true produces JSON output", () => {
    const reg = makeMockRegistry([NODE_A]);
    const out = { write: vi.fn() };
    const code = runNodeList(reg, { json: true }, out);

    expect(code).toBe(0);
    const written = out.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written) as NodeSummary[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].nodeId).toBe("node-alpha");
  });
});

// ════════════════════════════════════════════════════════════════════════
// runNodeShow
// ════════════════════════════════════════════════════════════════════════

describe("runNodeShow", () => {
  it("returns 0 for known node", () => {
    const reg = makeMockRegistry([NODE_A]);
    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = runNodeShow(reg, "node-alpha", {}, out, errOut);

    expect(code).toBe(0);
    const written = out.write.mock.calls[0][0] as string;
    expect(written).toContain("node-alpha");
    expect(errOut.write).not.toHaveBeenCalled();
  });

  it("returns 1 for unknown node", () => {
    const reg = makeMockRegistry([NODE_A]);
    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = runNodeShow(reg, "no-such-node", {}, out, errOut);

    expect(code).toBe(1);
    expect(out.write).not.toHaveBeenCalled();
    const errMsg = errOut.write.mock.calls[0][0] as string;
    expect(errMsg).toContain("no-such-node");
  });

  it("with json: true produces JSON output for known node", () => {
    const reg = makeMockRegistry([NODE_A]);
    const out = { write: vi.fn() };
    const errOut = { write: vi.fn() };
    const code = runNodeShow(reg, "node-alpha", { json: true }, out, errOut);

    expect(code).toBe(0);
    const written = out.write.mock.calls[0][0] as string;
    const parsed = JSON.parse(written) as NodeDetail;
    expect(parsed.nodeId).toBe("node-alpha");
    expect(parsed.maxArms).toBe(8);
  });
});
