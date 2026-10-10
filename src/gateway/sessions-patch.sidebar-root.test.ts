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

function childStore(extra: Partial<SessionEntry> = {}): Record<string, SessionEntry> {
  return { [key]: { sessionId: "child", updatedAt: 1, ...lineage, ...extra } };
}

describe("persistent sidebar roots", () => {
  test("promotes and pins atomically without changing lineage or execution authority", async () => {
    const store = childStore();
    const promoted = expectPatchOk(
      await runPatch({
        store,
        storeKey: key,
        patch: { key, sidebarRoot: true, pinned: true, expectedSessionId: "child" },
      }),
    );
    expect(promoted).toMatchObject({ ...lineage, sidebarRoot: true, pinnedAt: expect.any(Number) });
    const snoozedUntil = Date.now() + 60_000;
    expect(
      expectPatchOk(
        await runPatch({
          store,
          storeKey: key,
          patch: { key, snoozedUntil, expectedSessionId: "child" },
        }),
      ),
    ).toMatchObject({ ...lineage, sidebarRoot: true, snoozedUntil });
    const nested = expectPatchOk(
      await runPatch({
        store,
        storeKey: key,
        patch: { key, sidebarRoot: false, expectedSessionId: "child" },
      }),
    );
    expect(nested).toMatchObject(lineage);
    for (const field of ["sidebarRoot", "pinnedAt", "snoozedUntil", "snoozedAt"]) {
      expect(nested).not.toHaveProperty(field);
    }
    expectPatchError(
      await runPatch({ store, storeKey: key, patch: { key, pinned: true } }),
      "cannot pin a child session",
    );
  });

  test("keeps promotion across archive and restore", async () => {
    const store = childStore({ sidebarRoot: true, pinnedAt: 10 });
    for (const archived of [true, false]) {
      expect(
        expectPatchOk(
          await runPatch({
            store,
            storeKey: key,
            patch: { key, archived, expectedSessionId: "child" },
          }),
        ),
      ).toMatchObject({ ...lineage, sidebarRoot: true });
    }
  });

  test.each([
    { storeKey: "agent:main:subagent:hidden", error: "cannot promote a hidden subagent run" },
    { entry: { sessionId: "" }, error: "session not found" },
    { patch: { expectedSessionId: undefined }, error: "expectedSessionId required" },
    {
      entry: { sidebarRoot: true },
      patch: { sidebarRoot: false, pinned: true },
      error: "cannot pin a child session",
    },
  ] satisfies {
    storeKey?: string;
    entry?: Partial<SessionEntry>;
    patch?: Partial<SessionsPatchParams>;
    error: string;
  }[])(
    "rejects invalid promotion $error without changing state",
    async ({ storeKey = key, entry, patch, error }) => {
      const original = { sessionId: "child", updatedAt: 1, ...lineage, ...entry };
      const store = { [storeKey]: original };
      expectPatchError(
        await runPatch({
          store,
          storeKey,
          patch: { key: storeKey, sidebarRoot: true, expectedSessionId: "child", ...patch },
        }),
        error,
      );
      expect(store[storeKey]).toBe(original);
    },
  );
});
