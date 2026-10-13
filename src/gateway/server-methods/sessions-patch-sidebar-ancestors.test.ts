import { expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionPatchSidebarAncestors } from "./sessions-patch-sidebar-ancestors.js";

it("checks retained ancestor placement without host SQL and rejects archival and promotion", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const root = "agent:main:dashboard:guard-root";
    const child = "agent:main:dashboard:guard-child";
    const scope = (key: string) => ({ agentId: "main", sessionKey: key });
    const entry = { sessionId: root, updatedAt: 1 };
    replaceSessionEntrySync(scope(root), entry);
    replaceSessionEntrySync(scope(child), {
      sessionId: child,
      updatedAt: 1,
      parentSessionKey: root,
    });
    const guard = await prepareSessionPatchSidebarAncestors({
      cfg: {},
      getCurrentConfig: () => ({}),
      key: child,
      agentId: "main",
      assertCallerCurrent() {},
      ancestors: [
        { key: root, expectedSessionId: root, expectedSidebarRoot: false, expectedCategory: null },
      ],
    });
    try {
      await replaceSessionEntry(scope(root), { ...entry, label: "Renamed" });
      const sql = observeHostDataSql();
      try {
        expect(() => guard.assertCurrent()).not.toThrow();
        for (const call of sql.calls) {
          expect(call).not.toHaveBeenCalled();
        }
      } finally {
        sql.restore();
      }
      await replaceSessionEntry(scope(root), { ...entry, archivedAt: 42 });
      expect(() => guard.assertCurrent()).toThrow("changed before patch");
      await replaceSessionEntry(scope(root), { ...entry, sidebarRoot: true });
      expect(() => guard.assertCurrent()).toThrow("changed before patch");
    } finally {
      guard.release();
    }
    expect(() => guard.assertCurrent()).toThrow("changed before patch");
  });
});

it("rejects an unrelated supplied ancestor without looking it up", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const child = "agent:main:dashboard:guard-child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: child },
      { sessionId: child, updatedAt: 1 },
    );
    await expect(
      prepareSessionPatchSidebarAncestors({
        cfg: {},
        getCurrentConfig: () => ({}),
        key: child,
        agentId: "main",
        assertCallerCurrent() {},
        ancestors: [
          {
            key: "agent:other:private",
            expectedSessionId: "secret",
            expectedSidebarRoot: false,
            expectedCategory: null,
          },
        ],
      }),
    ).rejects.toThrow("changed before patch");
  });
});
