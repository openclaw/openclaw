import { describe, expect, it, vi } from "vitest";
import { resolveNodeIdFromCandidates as resolve, type NodeMatchCandidate } from "./node-match.js";

const node = (nodeId: string, displayName?: string, extra: Partial<NodeMatchCandidate> = {}) => ({
  nodeId,
  displayName,
  ...extra,
});

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
    try {
      const result = [resolve(nodes, query), normalize.mock.calls.length];
      expect(result).toEqual([target.nodeId, 0]);
    } finally {
      normalize.mockRestore();
    }
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
        expect(() => resolve(candidates, "Shared Desk")).toThrow(/ambiguous node: Shared Desk/);
      }
    }
  });

  it("throws clear unknown and ambiguous node errors", () => {
    expect(() =>
      resolve([node("mac-123", "Mac Studio", { remoteIp: "100.0.0.1" }), node("pi-456")], "nope"),
    ).toThrow(/unknown node: nope.*known: Mac Studio, pi-456/);

    const iphones = ["ios-a", "ios-b"].map((id) => node(id, "iPhone", { connected: true }));
    expect(() => resolve(iphones, "iphone")).toThrow(
      /ambiguous node: iphone.*node=ios-a.*node=ios-b/,
    );

    expect(() => resolve([], "")).toThrow(/node required/);
  });

  it("matches Unicode names without letting punctuation select them", () => {
    const nodes = [node("cn-desktop", "工作站"), node("cn-laptop", "笔记本")];
    expect(resolve(nodes, "工作站")).toBe("cn-desktop");
    expect(() => resolve(nodes, "###")).toThrow(/unknown node: ###/);
  });

  it.each([
    ["script marks", ["किताब", "कुताब"], ["किताब", "कुताब"]],
    ["emoji decoration", ["Mac ❤️ Studio", "Node 1️⃣"], ["Mac Studio", "Node 1"]],
  ] as const)("normalizes %s without confusing nodes", (_name, names, queries) => {
    const nodes = names.map((name, index) => node(String(index), name));
    expect(queries.map((query) => resolve(nodes, query))).toEqual(["0", "1"]);
  });

  it.each([
    ["Mac Studio", "MacStudio", "MacStudio"],
    ["Cafe\u0301 01", "Cafe\u030101", "Café01"],
  ])("prefers exact %s matches to compact selectors", (spaced, compact, query) => {
    const nodes = [node("compact", spaced), node("exact", compact)];
    expect(resolve(nodes, query, true)).toBe("exact");
    expect(resolve(nodes.slice(0, 1), query, true)).toBe("compact");
  });

  it("requires callers to opt in to compact display-name selectors", () => {
    const nodes = [node("mac-compact", "Mac Studio")];
    expect(() => resolve(nodes, "MacStudio")).toThrow(/unknown node: MacStudio/);
    expect(resolve(nodes, "MacStudio", true)).toBe("mac-compact");
  });
});
