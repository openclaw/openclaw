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
    let selected: string;
    let normalizations: number;
    try {
      selected = resolve(nodes, query);
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
        expect(() => resolve(candidates, "Shared Desk")).toThrow(/ambiguous node: Shared Desk/);
      }
    }
  });

  it("throws clear unknown and ambiguous node errors", () => {
    expect(() =>
      resolve([node("mac-123", "Mac Studio", { remoteIp: "100.0.0.1" }), node("pi-456")], "nope"),
    ).toThrow(/unknown node: nope.*known: Mac Studio, pi-456/);

    expect(() =>
      resolve(
        [
          node("ios-a", "iPhone", { connected: true }),
          node("ios-b", "iPhone", { connected: true }),
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*node=ios-a.*node=ios-b/);

    expect(() => resolve([], "")).toThrow(/node required/);
  });

  it("matches Unicode names without letting punctuation select them", () => {
    const nodes = [node("cn-desktop", "工作站"), node("cn-laptop", "笔记本")];
    expect(resolve(nodes, "工作站")).toBe("cn-desktop");
    expect(() => resolve(nodes, "###")).toThrow(/unknown node: ###/);
  });

  it("preserves combining marks that distinguish Unicode display names", () => {
    const nodes = [node("hi-short-i", "किताब"), node("hi-short-u", "कुताब")];
    expect(resolve(nodes, "किताब")).toBe("hi-short-i");
    expect(resolve(nodes, "कुताब")).toBe("hi-short-u");
  });

  it("ignores emoji decoration marks during display-name matching", () => {
    const nodes = [node("heart", "Mac ❤️ Studio"), node("keycap", "Node 1️⃣")];
    expect(resolve(nodes, "Mac Studio")).toBe("heart");
    expect(resolve(nodes, "Node 1")).toBe("keycap");
  });

  it("keeps compact display-name selectors below exact name matches", () => {
    const nodes = [
      node("mac-compact", "Mac Studio"),
      node("mac-exact", "MacStudio"),
      node("cafe-compact", "Cafe\u0301 01"),
      node("cafe-exact", "Cafe\u030101"),
    ];
    expect(resolve(nodes, "MacStudio", true)).toBe("mac-exact");
    expect(resolve([nodes[0]!, nodes[2]!], "MacStudio", true)).toBe("mac-compact");
    expect(resolve([nodes[2]!, nodes[3]!], "Café01", true)).toBe("cafe-exact");
    expect(resolve([nodes[2]!], "Café01", true)).toBe("cafe-compact");
  });

  it("requires callers to opt in to compact display-name selectors", () => {
    const nodes = [node("mac-compact", "Mac Studio")];
    expect(() => resolve(nodes, "MacStudio")).toThrow(/unknown node: MacStudio/);
    expect(resolve(nodes, "MacStudio", true)).toBe("mac-compact");
  });
});
