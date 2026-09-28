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

  it("retains ambiguity across duplicate exact ids", () => {
    const nodes = [
      { nodeId: "duplicate", displayName: "First", connected: true },
      { nodeId: "duplicate", displayName: "Second", connected: true },
    ];
    expect(() => resolveNodeIdFromCandidates(nodes, "duplicate")).toThrow(
      "ambiguous node: duplicate (matches: First [node=duplicate], Second [node=duplicate])",
    );
  });

  it("selects the connected record across all exact IP matches", () => {
    const nodes = [
      { nodeId: "offline", remoteIp: "198.51.100.17", connected: false },
      { nodeId: "online", remoteIp: "198.51.100.17", connected: true },
    ];
    for (const candidates of [nodes, nodes.toReversed()]) {
      expect(resolveNodeIdFromCandidates(candidates, "198.51.100.17")).toBe("online");
    }
  });

  it("keeps an offline exact id above connected IP and name matches", () => {
    const query = "198.51.100.17";
    const nodes = [
      { nodeId: "ip-match", remoteIp: query, connected: true },
      { nodeId: "name-match", displayName: query, connected: true },
      { nodeId: query, connected: false },
    ];
    for (const candidates of [nodes, nodes.toReversed()]) {
      expect(resolveNodeIdFromCandidates(candidates, query)).toBe(query);
    }
  });

  it("normalizes node keys by lowercasing and collapsing separators", () => {
    for (const [displayName, query] of [
      [" Mac Studio! ", "mac-studio"],
      ["---PI__Node---", "pi node"],
      ["Cafe\u0301 01", "café-01"],
    ] as const) {
      expect(resolveNodeIdFromCandidates([{ nodeId: "node-1", displayName }], query)).toBe(
        "node-1",
      );
    }
    for (const displayName of ["❤️", "###"]) {
      expect(() =>
        resolveNodeIdFromCandidates([{ nodeId: "node-1", displayName }], "named-node"),
      ).toThrow(/unknown node/);
    }
  });

  it("prefers the strongest match type before client heuristics", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-studio", displayName: "Other Node", connected: false },
          { nodeId: "mac-2", displayName: "Mac Studio", connected: true },
        ],
        "mac-studio",
      ),
    ).toBe("mac-studio");
  });

  it.each([
    { clientIds: ["openclaw-macos", "node-host"] },
    { clientIds: ["openclaw-macos", "openclaw-linux"] },
    { clientIds: ["openclaw-macos", undefined] },
    { clientIds: ["openclaw-macos", "clawdbot-macos", "node-host"] },
    { clientIds: ["clawdbot-macos", undefined] },
  ])("keeps non-migration ties ambiguous for $clientIds", ({ clientIds }) => {
    for (const connected of [true, false, undefined]) {
      const nodes = clientIds.map((clientId, index) => ({
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

  it.each([true, false, undefined])(
    "keeps the unique current client in an entirely legacy migration tie (connected=%s)",
    (connected) => {
      const nodes = ["clawdbot-macos", "moldbot-macos", " OpenClaw-MacOS "].map(
        (clientId, index) => ({
          nodeId: `node-${index}`,
          displayName: "Shared Desk",
          clientId,
          connected,
        }),
      );
      for (const candidates of [nodes, nodes.toReversed()]) {
        expect(resolveNodeIdFromCandidates(candidates, "Shared Desk")).toBe("node-2");
      }
    },
  );

  it.each(["node-host", "clawdbot-macos", undefined])(
    "prefers a connected %s client over a disconnected current app",
    (clientId) => {
      const nodes = [
        { nodeId: "app", displayName: "Shared Desk", clientId: "openclaw-macos", connected: false },
        { nodeId: "live", displayName: "Shared Desk", clientId, connected: true },
      ];
      for (const candidates of [nodes, nodes.toReversed()]) {
        expect(resolveNodeIdFromCandidates(candidates, "Shared Desk")).toBe("live");
      }
    },
  );

  it("falls back to raw ambiguous matches when none of them are connected", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "ios-a", displayName: "iPhone", connected: false },
          { nodeId: "ios-b", displayName: "iPhone", connected: false },
        ],
        "iphone",
      ),
    ).toThrow(/ambiguous node: iphone.*node=ios-a.*node=ios-b/);
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

  it("prints client ids in ambiguous-node errors when available", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          {
            nodeId: "legacy-mac",
            displayName: "Peter’s Mac Studio",
            clientId: "clawdbot-macos",
            connected: true,
          },
          {
            nodeId: "other-mac",
            displayName: "Peter’s Mac Studio",
            clientId: "openclaw-macos",
            connected: true,
          },
          {
            nodeId: "third-mac",
            displayName: "Peter’s Mac Studio",
            clientId: "openclaw-macos",
            connected: true,
          },
        ],
        "Peter's Mac Studio",
      ),
    ).toThrow(
      /ambiguous node: Peter's Mac Studio.*node=other-mac.*client=openclaw-macos.*node=third-mac.*client=openclaw-macos/,
    );
  });

  it("lists remote ips in unknown-node errors when display names are missing", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [{ nodeId: "mac-123", remoteIp: "100.0.0.1" }, { nodeId: "pi-456" }],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: 100.0.0.1, pi-456/);
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
