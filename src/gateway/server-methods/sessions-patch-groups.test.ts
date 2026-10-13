import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runSessionPatchGroups } from "./sessions-patch-groups.js";
import type { PreparedPatchTarget } from "./sessions-patch-types.js";

function target(index: number, agentId: string, depth?: number): PreparedPatchTarget {
  const key = "agent:" + agentId + ":dashboard:" + index;
  return {
    index,
    key,
    canonicalKey: key,
    targetAgentId: agentId,
    archiveActor: undefined,
    storePath: agentId + ".sqlite",
    initialStoreKeys: [key],
    lifecycleIdentities: [key],
    fullPatch: {
      key,
      archived: true,
      ...(depth === undefined
        ? {}
        : {
            expectedSidebarAncestors: Array.from({ length: depth }, (_, ancestor) => ({
              key: "ancestor-" + ancestor,
              expectedSessionId: "ancestor-" + ancestor,
              expectedSidebarRoot: false,
              expectedCategory: null,
            })),
          }),
    },
    archivePreparation: {
      canonicalKey: key,
      drain: {
        handoffToMutation() {},
        release() {},
        hasAuthoritativeWork: () => false,
      },
    },
  };
}

it("settles deepest tree targets before parents across interleaved stores", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const calls: number[][] = [];
  const running = runSessionPatchGroups(
    [target(0, "main", 0), target(1, "other", 1), target(2, "main", 2)],
    async (group) => {
      calls.push(group.map((entry) => entry.index));
      if (group[0]?.index === 2) {
        entered.resolve();
        await release.promise;
      }
    },
  );
  await entered.promise;
  try {
    expect(calls).toEqual([[2]]);
  } finally {
    release.resolve();
    await running;
  }
  expect(calls).toEqual([[2], [1], [0]]);
});

it("keeps ordinary patches grouped by physical store and omits undrained archive targets", async () => {
  const failed = target(3, "other");
  failed.archivePreparation = undefined;
  const calls: number[][] = [];
  await runSessionPatchGroups(
    [target(0, "main"), target(1, "other"), target(2, "main"), failed],
    async (group) => {
      calls.push(group.map((entry) => entry.index));
    },
  );
  expect(calls).toEqual([[0, 2], [1]]);
});
