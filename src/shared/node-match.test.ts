import { describe, expect, it } from "vitest";
import { resolveNodeIdFromCandidates } from "./node-match.js";

describe("resolveNodeIdFromCandidates", () => {
  it("matches nodeId", () => {
    expect(
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456", displayName: "Raspberry Pi", remoteIp: "100.0.0.2" },
        ],
        "pi-456",
      ),
    ).toBe("pi-456");
  });

  it("matches displayName using normalization", () => {
    expect(
      resolveNodeIdFromCandidates([{ nodeId: "mac-123", displayName: "Mac Studio" }], "mac studio"),
    ).toBe("mac-123");
  });

  it("matches nodeId prefix (>=6 chars)", () => {
    expect(resolveNodeIdFromCandidates([{ nodeId: "mac-abcdef" }], "mac-ab")).toBe("mac-abcdef");
  });

  it("throws unknown node with known list", () => {
    expect(() =>
      resolveNodeIdFromCandidates(
        [
          { nodeId: "mac-123", displayName: "Mac Studio", remoteIp: "100.0.0.1" },
          { nodeId: "pi-456" },
        ],
        "nope",
      ),
    ).toThrow(/unknown node: nope.*known: /);
  });

  it("throws ambiguous node with matches list", () => {
    expect(() =>
      resolveNodeIdFromCandidates([{ nodeId: "mac-abcdef" }, { nodeId: "mac-abc999" }], "mac-abc"),
    ).toThrow(/ambiguous node: mac-abc.*matches:/);
  });
});
