// Node list parsing tests cover normalized node inventory records.
import { describe, expect, it } from "vitest";
import { parseNodeList, parsePairingList } from "./node-list-parse.js";

describe("shared/node-list-parse", () => {
  it("parses node.list payloads", () => {
    expect(parseNodeList({ nodes: [{ nodeId: "node-1" }] })).toEqual([{ nodeId: "node-1" }]);
    expect(parseNodeList({ nodes: "nope" })).toStrictEqual([]);
    expect(parseNodeList(null)).toStrictEqual([]);
    expect(parseNodeList(["not-an-object"])).toStrictEqual([]);
  });

  it("parses node.pair.list payloads", () => {
    expect(
      parsePairingList({
        pending: [
          {
            requestId: "r1",
            nodeId: "n1",
            ts: 1,
            requiredApproveScopes: ["operator.pairing"],
          },
        ],
        paired: [{ nodeId: "n1" }],
      }),
    ).toEqual({
      pending: [
        {
          requestId: "r1",
          nodeId: "n1",
          ts: 1,
          requiredApproveScopes: ["operator.pairing"],
        },
      ],
      paired: [{ nodeId: "n1" }],
    });
    expect(parsePairingList({ pending: 1, paired: "x" })).toEqual({ pending: [], paired: [] });
    expect(parsePairingList(undefined)).toEqual({ pending: [], paired: [] });
    expect(parsePairingList(["not-an-object"])).toEqual({ pending: [], paired: [] });
  });

  it("preserves valid pairing arrays when the sibling field is malformed", () => {
    expect(
      parsePairingList({
        pending: [{ requestId: "r1", nodeId: "n1", ts: 1 }],
        paired: "x",
      }),
    ).toEqual({
      pending: [{ requestId: "r1", nodeId: "n1", ts: 1 }],
      paired: [],
    });

    expect(
      parsePairingList({
        pending: 1,
        paired: [{ nodeId: "n1" }],
      }),
    ).toEqual({
      pending: [],
      paired: [{ nodeId: "n1" }],
    });
  });

  it("normalizes non-string scalars from malformed pairing rows", () => {
    const { pending, paired } = parsePairingList({
      pending: [{ requestId: 7, nodeId: {}, displayName: 42, remoteIp: 99, platform: true, ts: 1 }],
      paired: [{ nodeId: 5, displayName: { x: 1 }, remoteIp: [], token: 3, lastSeenReason: 0 }],
    });
    // Required ids coerce to "", optional scalars normalize to undefined — no non-string survives
    // for the CLI renderers that call .trim()/sanitizeTerminalText on these fields.
    expect(pending[0]).toMatchObject({ requestId: "", nodeId: "" });
    expect(pending[0].displayName).toBeUndefined();
    expect(pending[0].remoteIp).toBeUndefined();
    expect(pending[0].platform).toBeUndefined();
    expect(paired[0]).toMatchObject({ nodeId: "" });
    expect(paired[0].displayName).toBeUndefined();
    expect(paired[0].remoteIp).toBeUndefined();
    expect(paired[0].token).toBeUndefined();
    expect(paired[0].lastSeenReason).toBeUndefined();
  });
});
