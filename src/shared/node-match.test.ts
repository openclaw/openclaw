import { describe, expect, it } from "vitest";
import { normalizeNodeKey, resolveNodeIdFromCandidates, resolveNodeMatches } from "./node-match.js";

describe("shared/node-match", () => {
  it("normalizes node keys by lowercasing and collapsing separators", () => {
    expect(normalizeNodeKey(" Mac Studio! ")).toBe("mac-studio");
    expect(normalizeNodeKey("---PI__Node---")).toBe("pi-node");
    expect(normalizeNodeKey("###")).toBe("");
  });

  it("matches candidates by node id, remote ip, normalized name, and long prefix", () => {
    const nodes = [
      { nodeId: "mac-abcdef", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
      { nodeId: "pi-456789", displayName: "Raspberry Pi", remoteIp: "100.0.0.2" },
    ];

    expect(resolveNodeMatches(nodes, "mac-abcdef")).toEqual([nodes[0]]);
    expect(resolveNodeMatches(nodes, "100.0.0.2")).toEqual([nodes[1]]);
    expect(resolveNodeMatches(nodes, "mac studio")).toEqual([nodes[0]]);
    expect(resolveNodeMatches(nodes, "  Mac---Studio!! ")).toEqual([nodes[0]]);
    expect(resolveNodeMatches(nodes, "pi-456")).toEqual([nodes[1]]);
    expect(resolveNodeMatches(nodes, "pi")).toEqual([]);
    expect(resolveNodeMatches(nodes, "   ")).toEqual([]);
  });

  it("resolves unique matches and prefers a unique connected node", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-old", displayName: "iPhone", connected: false },
          { nodeId: "ios-live", displayName: "iPhone", connected: true },
        ],
        "iphone",
      ),
    ).toBe("ios-live");
  });

  it("falls back to raw ambiguous matches when none of them are connected", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-a", displayName: "iPhone", connected: false },
          { nodeId: "ios-b", displayName: "iPhone", connected: false },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*matches: iPhone, iPhone/);
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
    ).toThrow(/ambiguous node: iphone.*matches: iPhone, iPhone/);

    expect(() => resolveNodeIdFromCandidates([], "")).toThrow(/node required/);
  });

  it("lists remote ips in unknown-node errors when display names are missing", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [{ nodeId: "mac-123", remoteIp: "100.0.0.1" }, { nodeId: "pi-456" }],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: 100.0.0.1, pi-456/);
  });
});
