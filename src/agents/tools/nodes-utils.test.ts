import { describe, expect, it } from "vitest";
import type { NodeListNode } from "./nodes-utils.js";
import { resolveNodeIdFromList } from "./nodes-utils.js";

function node(overrides: Partial<NodeListNode> & { nodeId: string }): NodeListNode {
  return {
    nodeId: overrides.nodeId,
    caps: ["canvas"],
    connected: true,
    ...overrides,
  };
}

describe("resolveNodeIdFromList defaults", () => {
  it("falls back to first connected canvas-capable node when multiple non-Mac candidates exist", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios" }),
      node({ nodeId: "android-1", platform: "android" }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("ios-1");
  });

  it("preserves local Mac preference when exactly one local Mac candidate exists", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios" }),
      node({ nodeId: "mac-1", platform: "macos" }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("mac-1");
  });
});
