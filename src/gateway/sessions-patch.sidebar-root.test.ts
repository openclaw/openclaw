import { describe, expect, test } from "vitest";
import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/schema/sessions-patch.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { expectPatchError, expectPatchOk, runPatch } from "./sessions-patch.test-support.js";

const key = "agent:main:dashboard:child";
const parent = "agent:main:dashboard:parent";
const lineage = {
  parentSessionKey: parent,
  spawnedBy: parent,
  spawnedBySessionId: "parent-session",
  completionOwnerSessionKey: parent,
  forkSource: { sessionKey: parent, sessionId: "parent-session" },
  inheritedToolPolicyVersion: 1,
  inheritedToolAllow: ["read"],
  inheritedToolDeny: ["exec"],
  subagentControlScope: "children",
  permissionMode: "read-only",
} satisfies Partial<SessionEntry>;

function child(extra: Partial<SessionEntry> = {}, storeKey = key) {
  const original = { sessionId: "child", updatedAt: 1, ...lineage, ...extra };
  const store = { [storeKey]: original };
  const patch = (changes: Partial<SessionsPatchParams>) =>
    runPatch({
      store,
      storeKey,
      patch: { key: storeKey, expectedSessionId: "child", ...changes },
    });
  return { original, store, patch };
}

describe("persistent sidebar roots", () => {
  test("promotes and pins atomically without changing lineage or execution authority", async () => {
    const { patch } = child();
    const promoted = expectPatchOk(await patch({ sidebarRoot: true, pinned: true }));
    expect(promoted).toMatchObject({ ...lineage, sidebarRoot: true, pinnedAt: expect.any(Number) });
    const snoozedUntil = Date.now() + 60_000;
    expect(expectPatchOk(await patch({ snoozedUntil }))).toMatchObject({
      ...lineage,
      sidebarRoot: true,
      snoozedUntil,
    });
    const nested = expectPatchOk(await patch({ sidebarRoot: false }));
    expect(nested).toMatchObject(lineage);
    for (const field of ["sidebarRoot", "pinnedAt", "snoozedUntil", "snoozedAt"]) {
      expect(nested).not.toHaveProperty(field);
    }
    expectPatchError(
      await patch({ pinned: true, expectedSessionId: undefined }),
      "cannot pin a child session",
    );
  });

  test("keeps promotion across archive and restore", async () => {
    const { patch } = child({ sidebarRoot: true, pinnedAt: 10 });
    for (const archived of [true, false]) {
      expect(expectPatchOk(await patch({ archived }))).toMatchObject({
        ...lineage,
        sidebarRoot: true,
      });
    }
  });

  test.each<[string, Partial<SessionEntry>, Partial<SessionsPatchParams>, string]>([
    ["agent:main:subagent:hidden", {}, {}, "cannot promote a hidden subagent run"],
    [key, { sessionId: "" }, {}, "session not found"],
    [key, {}, { expectedSessionId: undefined }, "expectedSessionId required"],
    [
      key,
      { sidebarRoot: true },
      { sidebarRoot: false, pinned: true },
      "cannot pin a child session",
    ],
  ])("rejects promotion for %s: %j / %j (%s)", async (storeKey, entry, patch, error) => {
    const value = child(entry, storeKey);
    expectPatchError(await value.patch({ sidebarRoot: true, ...patch }), error);
    expect(value.store[storeKey]).toBe(value.original);
  });
});
