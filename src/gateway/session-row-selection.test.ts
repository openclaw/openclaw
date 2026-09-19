import { expect, it, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as sessionKeys from "../sessions/session-key-utils.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";

it("reuses resident key predicates across list requests and refreshes entry classification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const keys = [
      "agent:main:dashboard:visible",
      "agent:main:cron:job:run:one",
      "agent:main:subagent:child",
      "agent:main:matrix:channel:!Room:example.org:thread:$Event",
      "agent:main:signal:group:OpaqueGroup",
      "agent:main:sessions",
    ] as const;
    for (const sessionKey of keys) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 1 },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      const opts = { agentId: "main", excludeSubagents: true, archived: "all" as const };
      const expected = [keys[0], keys[3], keys[4], keys[5]].toSorted();
      for (let iteration = 0; iteration < 2; iteration++) {
        const prepared = prepareSessionRowSelection(projection, opts);
        const cron = vi.spyOn(sessionKeys, "isCronRunSessionKey");
        const subagent = vi.spyOn(sessionKeys, "isSubagentSessionKey");
        try {
          expect(
            filterAndSortSessionEntries(prepared)
              .map(([key]) => key)
              .toSorted(),
          ).toEqual(expected);
          expect(cron).not.toHaveBeenCalled();
          expect(subagent).not.toHaveBeenCalled();
        } finally {
          cron.mockRestore();
          subagent.mockRestore();
        }
      }
      const sessionKey = keys[0];
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 2,
          spawnedBy: "agent:main:parent",
          archivedAt: 2,
        },
      );
      const hidden = await listProjectedSessions({ projection, opts });
      expect(hidden.sessions.map((row) => row.key).toSorted()).toEqual(
        expected.filter((key) => key !== sessionKey),
      );
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt: 3, archivedAt: 2 },
      );
      const restored = await listProjectedSessions({ projection, opts });
      expect(restored.sessions.map((row) => row.key).toSorted()).toEqual(expected);
    } finally {
      projection.dispose();
    }
  });
});

it.each([false, true])(
  "preserves sentinel precedence, ties, and resident order before filtering (activeOnly: %s)",
  async (activeOnly) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {}, ops: {} } } };
      const projection = createSessionRowProjectionFixture({ cfg, store: {} });
      const samples = [
        ["shadow-global", "global", "main", "fallback"],
        ["ordinary", "agent:main:ordinary", "main", "primary"],
        ["main-global", "global", "main", "primary"],
        ["ops-global", "global", "ops", "primary"],
        ["ops-shadow", "global", "ops", "fallback"],
        ["unknown-winner", "unknown", "ops", "primary"],
        ["unknown-shadow", "unknown", "main", "fallback"],
        ["excluded", "agent:main:ordinary", "main", "excluded"],
        ["retired", "agent:retired:ordinary", "retired", "primary"],
      ] as const;
      const rows = samples.map(([sessionId, key, agentId, storePath]) => {
        const entry = { sessionId, updatedAt: 1 };
        return {
          ...createSessionRow(
            {
              key,
              agentId,
              storeTarget: { agentId, storePath },
            },
            entry,
          ),
          entry,
        };
      });
      projection.selectEntries = () => rows;
      projection.state.scope = () => ({
        paths: new Map([
          ["primary", 0],
          ["fallback", 1],
        ]),
        path: "(multiple)",
        agentId: undefined,
        configuredAgentIds: new Set(["main", "ops"]),
      });
      try {
        const prepared = prepareSessionRowSelection(projection, {
          activeOnly,
          configuredAgentsOnly: true,
          includeGlobal: true,
          includeUnknown: true,
        });
        expect(prepared.entries.map(([, entry]) => entry.sessionId)).toEqual(
          activeOnly
            ? ["ordinary", "main-global", "ops-global", "unknown-winner", "unknown-shadow"]
            : ["ordinary", "main-global", "unknown-winner"],
        );
        for (const [key, entry] of prepared.entries) {
          const target = prepared.getTarget(key)!;
          const original = rows.find((row) => row.entry === entry)!;
          expect(target.entry).toBe(entry);
          expect(target.storeTarget).toBe(original.storeTarget);
          expect(target.storeKey ?? key).toBe(original.key);
          if (!activeOnly || original.key.startsWith("agent:")) {
            expect(target).toBe(original);
          }
        }
        const visible = filterAndSortSessionEntries({
          ...prepared,
          entryFilter: (_key, entry) => entry.sessionId !== "main-global",
        });
        expect(visible.map(([, entry]) => entry.sessionId)).toEqual(
          expect.not.arrayContaining(["main-global", "shadow-global", "ops-shadow"]),
        );
        expect(rows.map((row) => row.entry.sessionId)).toEqual(samples.map(([id]) => id));
        const scoped = filterAndSortSessionEntries({
          ...prepared,
          opts: { ...prepared.opts, agentId: "ops" },
        });
        expect(scoped.map(([, entry]) => entry.sessionId)).toEqual(
          activeOnly ? ["main-global", "ops-global", "unknown-winner"] : ["main-global"],
        );
      } finally {
        projection.dispose();
      }
    });
  },
);

it("rejects duplicate ordinary keys introduced after store admission before filtering or pagination", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    const key = "agent:main:original";
    for (const [storePath, sessionKey] of [
      [primary, key],
      [secondary, "agent:main:other"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey },
        { sessionId: sessionKey, updatedAt: Date.now() },
      );
      registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const opts = { configuredAgentsOnly: true };
      expect((await listProjectedSessions({ projection, opts })).sessions).toHaveLength(2);
      const duplicate = { agentId: "main", storePath: secondary, sessionKey: key };
      replaceSessionEntrySync(duplicate, { sessionId: "duplicate", updatedAt: Date.now() + 1 });
      await expect(
        listProjectedSessions({ projection, opts: { ...opts, limit: 1, offset: 1 } }),
      ).rejects.toThrow("duplicate rows resolve to canonical session key");
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: secondary,
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      const result = await listProjectedSessions({ projection, opts });
      expect(result.sessions.map((row) => row.key).toSorted()).toEqual([key, "agent:main:other"]);
    } finally {
      projection.dispose();
    }
  });
});
