// @vitest-environment node
import { describe, expect, it } from "vitest";
import { disambiguate } from "./place-labels.ts";

type LabelFixture = {
  nodeId: string;
  displayName: string;
  modelIdentifier?: string;
  remoteIp?: string;
};

const nodeCandidates = [
  (node: LabelFixture) => node.modelIdentifier,
  (node: LabelFixture) => node.remoteIp,
  (node: LabelFixture) => node.nodeId.slice(0, 8),
];
const node = (nodeId: string, modelIdentifier?: string, remoteIp?: string): LabelFixture => ({
  nodeId,
  displayName: "Mac Studio",
  modelIdentifier,
  remoteIp,
});

describe("disambiguate", () => {
  it.each<[string, LabelFixture[], (string | undefined)[]]>([
    [
      "leaves unique labels alone",
      [node("11111111", "Mac14,12"), { ...node("22222222", "Mac15,3"), displayName: "MacBook" }],
      [undefined, undefined],
    ],
    [
      "uses models when they differ",
      [node("11111111", "Mac14,12"), node("22222222", "Mac15,14")],
      ["Mac14,12", "Mac15,14"],
    ],
    [
      "advances past a partly distinct model candidate",
      [
        node("11111111", "Model A", "192.168.1.11"),
        node("22222222", "Model A", "192.168.1.12"),
        node("33333333", "Model B", "192.168.1.13"),
      ],
      ["192.168.1.11", "192.168.1.12", "192.168.1.13"],
    ],
    [
      "falls back to short IDs when facts are missing",
      [node("11111111aaaa"), node("22222222bbbb")],
      ["11111111", "22222222"],
    ],
    [
      "uses the final fallback for a member missing the selected fact",
      [node("11111111aaaa", "Mac14,12"), node("22222222bbbb", "Mac15,14"), node("33333333cccc")],
      ["Mac14,12", "Mac15,14", "33333333"],
    ],
    [
      "uses the last candidate when none is fully distinct",
      [
        node("11111111aaaa", "Mac14,12", "192.168.1.11"),
        node("11111111bbbb", "Mac14,12", "192.168.1.11"),
      ],
      ["11111111", "11111111"],
    ],
  ])("%s", (_name, items, expected) => {
    expect(disambiguate(items, (item) => item.displayName, nodeCandidates)).toEqual(expected);
  });

  it("uses parent folders, then full paths, for recent basename collisions", () => {
    const items: Array<{ folder: string; label: string }> = [
      { folder: "/a/openclaw", label: "openclaw" },
      { folder: "/b/openclaw", label: "openclaw" },
      { folder: "/one/shared/openclaw", label: "openclaw · Mac Studio" },
      { folder: "/two/shared/openclaw", label: "openclaw · Mac Studio" },
    ];
    expect(
      disambiguate(items, (item) => item.label, [
        (item) => item.folder.split("/").at(-2),
        (item) => item.folder,
        (item) => item.folder,
      ]),
    ).toEqual(["a", "b", "/one/shared/openclaw", "/two/shared/openclaw"]);
  });
});
