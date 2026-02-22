import { describe, expect, it } from "vitest";
import { parseNodeList, parsePairingList } from "./node-list-parse.js";

describe("shared/node-list-parse", () => {
  it("parses node.list payloads", () => {
    expect(parseNodeList({ nodes: [{ nodeId: "node-1" }] })).toEqual([{ nodeId: "node-1" }]);
    expect(parseNodeList({ nodes: "nope" })).toEqual([]);
    expect(parseNodeList(null)).toEqual([]);
  });

  it("parses node.pair.list payloads", () => {
    expect(
      parsePairingList({
        pending: [{ requestId: "r1", nodeId: "n1", ts: 1 }],
        paired: [{ nodeId: "n1" }],
      }),
    ).toEqual({
      pending: [{ requestId: "r1", nodeId: "n1", ts: 1 }],
      paired: [{ nodeId: "n1" }],
    });
    expect(parsePairingList({ pending: 1, paired: "x" })).toEqual({ pending: [], paired: [] });
    expect(parsePairingList(undefined)).toEqual({ pending: [], paired: [] });
  });
});
