import { describe, expect, it } from "vitest";
import {
  resolveOpaqueSessionFirstKeptEntryId,
  walkSessionCurrentTurn,
} from "./session-entry-navigation.js";

type Step = { id: string; parentId: string | null; traversable: boolean };

/** Drives the walk with a fixed parent lookup, collecting the ids it asks about. */
function driveWalk(startId: string, limit: number, parents: Map<string, Step>) {
  const asked: string[] = [];
  const walk = walkSessionCurrentTurn(startId, limit) as Generator<
    string,
    string | null,
    Step | undefined
  >;
  let step = walk.next();
  while (!step.done) {
    asked.push(step.value);
    step = walk.next(parents.get(step.value));
  }
  return { asked, stoppedAt: step.value };
}

const chain = (...ids: string[]) => {
  const parents = new Map<string, Step>();
  ids.forEach((id, index) => {
    parents.set(id, { id, parentId: ids[index + 1] ?? null, traversable: true });
  });
  return parents;
};

it("walks the whole parent chain when the budget allows it", () => {
  const { asked, stoppedAt } = driveWalk("c", 10, chain("c", "b", "a"));
  expect(asked).toEqual(["c", "b", "a"]);
  // The walk ends past the oldest row it could still advance from.
  expect(stoppedAt).toBeNull();
});

it("stops on the row it could not resolve instead of skipping over it", () => {
  // The caller could not produce a row for this id, so replay must stop here rather than
  // treating it as a root and returning null.
  const { asked, stoppedAt } = driveWalk("c", 10, new Map());
  expect(asked).toEqual(["c"]);
  expect(stoppedAt).toBe("c");
});

it("stops when the resolved row belongs to a different id", () => {
  const parents = new Map<string, Step>([
    ["c", { id: "someone-else", parentId: "b", traversable: true }],
  ]);
  const { asked, stoppedAt } = driveWalk("c", 10, parents);
  expect(asked).toEqual(["c"]);
  expect(stoppedAt).toBe("c");
});

it("stops at a row marked untraversable", () => {
  const parents = new Map<string, Step>([["c", { id: "c", parentId: "b", traversable: false }]]);
  const { asked, stoppedAt } = driveWalk("c", 10, parents);
  expect(asked).toEqual(["c"]);
  expect(stoppedAt).toBe("c");
});

it("does not walk past the ancestor budget", () => {
  const { asked, stoppedAt } = driveWalk("d", 2, chain("d", "c", "b", "a"));
  expect(asked).toEqual(["d", "c"]);
  // Budget exhaustion hands back the next id, not the last one it visited.
  expect(stoppedAt).toBe("b");
});

describe("resolveOpaqueSessionFirstKeptEntryId", () => {
  const canonical = (id: string, parentId: string | null) => ({ id, parentId });

  it("returns a first-kept id that is already canonical", () => {
    const resolved = resolveOpaqueSessionFirstKeptEntryId({
      firstKeptEntryId: "b",
      parentId: "c",
      fallbackParentId: "fallback",
      byId: new Map([
        ["b", canonical("b", "a")],
        ["c", canonical("c", "b")],
      ]),
      opaqueParentsById: new Map(),
      entries: () => [canonical("b", "a"), canonical("c", "b")],
    });
    expect(resolved).toBe("b");
  });

  it("follows the opaque chain to the canonical ancestor", () => {
    const resolved = resolveOpaqueSessionFirstKeptEntryId({
      firstKeptEntryId: "opaque-leaf",
      parentId: "c",
      fallbackParentId: "fallback",
      byId: new Map([
        ["b", canonical("b", "a")],
        ["c", canonical("c", "b")],
      ]),
      opaqueParentsById: new Map([["opaque-leaf", "b"]]),
      entries: () => [canonical("b", "a"), canonical("c", "b")],
    });
    expect(resolved).toBe("b");
  });

  it("falls back when the first-kept id is not part of the branch", () => {
    const resolved = resolveOpaqueSessionFirstKeptEntryId({
      firstKeptEntryId: "unknown",
      parentId: "c",
      fallbackParentId: "c",
      byId: new Map([["c", canonical("c", "b")]]),
      opaqueParentsById: new Map([["stray", null]]),
      entries: () => [canonical("c", "b")],
    });
    expect(resolved).toBe("c");
  });
});
