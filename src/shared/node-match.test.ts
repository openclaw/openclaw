// Node match tests cover node selection from names, ids, and address hints.
import { describe, expect, it, vi } from "vitest";
import { resolveNodeIdFromCandidates, type NodeMatchCandidate } from "./node-match.js";

describe("shared/node-match", () => {
  it.each(["id", "ip"])("resolves exact %s matches without normalizing display names", (kind) => {
    const nodes: NodeMatchCandidate[] = Array.from({ length: 1_000 }, (_, index) => ({
      nodeId: `node-${index}`,
      displayName: `Рабочая станция ${index}`,
      connected: true,
    }));
    const target = nodes[731]!;
    target.remoteIp = "198.51.100.17";
    const query = kind === "id" ? target.nodeId : target.remoteIp;
    const normalize = vi.spyOn(String.prototype, "normalize");
    let selected: string;
    let normalizations: number;
    try {
      selected = resolveNodeIdFromCandidates(nodes, query);
      normalizations = normalize.mock.calls.length;
    } finally {
      normalize.mockRestore();
    }
    expect(selected).toBe(target.nodeId);
    expect(normalizations).toBe(0);
  });

  it("keeps equally strong current and unspecified client ties ambiguous", () => {
    for (const connected of [true, false, undefined]) {
      const nodes = ["openclaw-macos", undefined].map((clientId, index) => ({
        nodeId: `node-${index}`,
        displayName: "Shared Desk",
        clientId,
        connected,
      }));
      for (const candidates of [nodes, nodes.toReversed()]) {
        expect(() => resolveNodeIdFromCandidates(candidates, "Shared Desk")).toThrow(
          /ambiguous node: Shared Desk/,
        );
      }
    }
  });

  it("throws clear unknown and ambiguous node errors", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456" },
        ],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: Mac Studio, pi-456/);

    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-a", displayName: "iPhone", connected: true },
          { nodeId: "ios-b", displayName: "iPhone", connected: true },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*node=ios-a.*node=ios-b/);

    expect(() => resolveNodeIdFromCandidates([], "")).toThrow(/node required/);
  });

  it("matches Unicode names without letting punctuation select them", () => {
    const nodes = [
      { nodeId: "cn-desktop", displayName: "工作站" },
      { nodeId: "cn-laptop", displayName: "笔记本" },
    ];
    expect(resolveNodeIdFromCandidates(nodes, "工作站")).toBe("cn-desktop");
    expect(() => resolveNodeIdFromCandidates(nodes, "###")).toThrow(/unknown node: ###/);
  });

  it("preserves combining marks that distinguish Unicode display names", () => {
    const nodes = [
      { nodeId: "hi-short-i", displayName: "किताब" },
      { nodeId: "hi-short-u", displayName: "कुताब" },
    ];
    expect(resolveNodeIdFromCandidates(nodes, "किताब")).toBe("hi-short-i");
    expect(resolveNodeIdFromCandidates(nodes, "कुताब")).toBe("hi-short-u");
  });

  it("ignores emoji decoration marks during display-name matching", () => {
    const nodes = [
      { nodeId: "heart", displayName: "Mac ❤️ Studio" },
      { nodeId: "keycap", displayName: "Node 1️⃣" },
    ];
    expect(resolveNodeIdFromCandidates(nodes, "Mac Studio")).toBe("heart");
    expect(resolveNodeIdFromCandidates(nodes, "Node 1")).toBe("keycap");
  });

  it("keeps compact display-name selectors below exact name matches", () => {
    const nodes = [
      { nodeId: "mac-compact", displayName: "Mac Studio" },
      { nodeId: "mac-exact", displayName: "MacStudio" },
      { nodeId: "cafe-compact", displayName: "Cafe\u0301 01" },
      { nodeId: "cafe-exact", displayName: "Cafe\u030101" },
    ];
    expect(resolveNodeIdFromCandidates(nodes, "MacStudio", true)).toBe("mac-exact");
    expect(resolveNodeIdFromCandidates([nodes[0]!, nodes[2]!], "MacStudio", true)).toBe(
      "mac-compact",
    );
    expect(resolveNodeIdFromCandidates([nodes[2]!, nodes[3]!], "Café01", true)).toBe("cafe-exact");
    expect(resolveNodeIdFromCandidates([nodes[2]!], "Café01", true)).toBe("cafe-compact");
  });

  it("requires callers to opt in to compact display-name selectors", () => {
    const nodes = [{ nodeId: "mac-compact", displayName: "Mac Studio" }];
    expect(() => resolveNodeIdFromCandidates(nodes, "MacStudio")).toThrow(
      /unknown node: MacStudio/,
    );
    expect(resolveNodeIdFromCandidates(nodes, "MacStudio", true)).toBe("mac-compact");
  });
});
