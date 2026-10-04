import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as sessionKeys from "../sessions/session-key-utils.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import * as childOwners from "./session-utils-core.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("maintains list order across metadata changes and archived-row rematerialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const first = "agent:main:first";
    const second = "agent:main:second";
    for (const [sessionKey, updatedAt, lastInteractionAt] of [
      [first, 2, 1],
      [second, 1, 2],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: sessionKey, updatedAt, lastInteractionAt },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const scan = vi.spyOn(projection, "selectEntries");
    try {
      const list = async (sortBy?: "lastInteractionAt" | "activity") =>
        (await listProjectedSessions({ projection, opts: { limit: 1, sortBy } })).sessions;
      expect((await list())[0]?.key).toBe(first);
      scan.mockClear();
      emitSessionTranscriptUpdate({
        target: { agentId: "main", sessionId: first, sessionKey: first },
      });
      expect((await list())[0]?.key).toBe(first);
      expect(scan.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(second);
      expect((await list("activity"))[0]?.key).toBe(second);
      expect((await list())[0]?.key).toBe(first);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: second },
        { sessionId: second, updatedAt: 3, label: "Changed metadata" },
      );
      expect((await list())[0]).toMatchObject({ key: second, label: "Changed metadata" });
      const third = "agent:main:third";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3 },
      );
      expect((await list())[0]?.key).toBe(third);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(third);
      expect(
        await listProjectedSessions({ projection, opts: { limit: 1, offset: 1 } }),
      ).toMatchObject({
        totalCount: 3,
        nextOffset: 2,
        hasMore: true,
        sessions: [{ key: second }],
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3, archivedAt: 5 },
      );
      expect((await list())[0]?.key).toBe(second);
      const archived = await listProjectedSessions({ projection, opts: { archived: true } });
      expect(archived.sessions.map((row) => row.key)).toEqual([third]);
      const archivedQuery = { agentId: "main", key: third };
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.isMaterialized(archivedQuery)).toBe(false);
      const rematerialized = await listProjectedSessions({
        projection,
        opts: { archived: true },
      });
      expect(rematerialized.sessions.map((row) => row.key)).toEqual([third]);
      expect(rematerialized.totalCount).toBe(1);
      expect(projection.isMaterialized(archivedQuery)).toBe(true);
      expect((await list())[0]?.key).toBe(second);
      expect(scan.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: projection.capture({ agentId: "main", key: third })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: third, storeKeys: [third] },
      });
      const remaining = await listProjectedSessions({
        projection,
        opts: { archived: "all", sortBy: "activity" },
      });
      expect(remaining.sessions.map((row) => row.key)).toEqual([second, first]);
      expect(remaining).toMatchObject({ totalCount: 2, nextOffset: null, hasMore: false });
      // Deletion publishes topology; keyed updates must reuse the rebuilt scope.
      scan.mockClear();
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: first },
        { sessionId: first, updatedAt: 2, lastInteractionAt: 1, pinnedAt: 10 },
      );
      expect((await list())[0]?.key).toBe(first);
      expect((await list("activity"))[0]?.key).toBe(second);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(first);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: first },
        { sessionId: first, updatedAt: 2, lastInteractionAt: 1, label: "Unpinned" },
      );
      expect((await list())[0]?.key).toBe(second);
      expect(scan.mock.calls.filter(([query]) => !query?.key)).toHaveLength(0);
      projection.onSelectionChange(() => {
        throw new Error("Synthetic selection observer failure");
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: first },
        { sessionId: first, updatedAt: 5, label: "Changed despite observer failure" },
      );
      expect((await list())[0]).toMatchObject({
        key: first,
        label: "Changed despite observer failure",
      });
      expect(() => projection.dispose()).not.toThrow();
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      scan.mockRestore();
      projection.dispose();
      release();
    }
  });
});

it("selects an exact row before pagination while retaining discovery filters", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:target";
    for (let index = 0; index < 7; index++) {
      const sessionKey = index === 0 ? key : `${key}-${index}`;
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        { sessionId: `transcript-${index}`, updatedAt: index + 1 },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const page = await listProjectedSessions({
        projection,
        opts: { agentId: "main", search: key, limit: 5 },
      });
      expect(page.sessions.map((row) => row.key)).not.toContain(key);
      const exact = await listProjectedSessions({
        projection,
        key,
        opts: { agentId: "main", limit: 1 },
      });
      expect(exact.sessions).toMatchObject([{ key, sessionId: "transcript-0" }]);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        { sessionId: "transcript-0", updatedAt: 8, archivedAt: 8 },
      );
      const hidden = await listProjectedSessions({
        projection,
        key,
        opts: { agentId: "main", limit: 1 },
      });
      expect(hidden.sessions).toEqual([]);
    } finally {
      projection.dispose();
    }
  });
});

it("reuses resident key predicates across list requests and refreshes legacy spawned classification", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const keys = [
      "agent:main:legacy-visible",
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
      for (const category of ["Research", " "]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 2,
            spawnedBy: "agent:main:parent",
            archivedAt: 2,
            category,
          },
        );
        const grouped = await listProjectedSessions({ projection, opts });
        expect(grouped.sessions.map((row) => row.key).toSorted()).toEqual(
          category.trim() ? expected : expected.filter((key) => key !== sessionKey),
        );
        expect(
          (
            await listProjectedSessions({ projection, opts: { ...opts, archived: false } })
          ).sessions.some((row) => row.key === sessionKey),
        ).toBe(false);
      }
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
      const parent = "agent:main:parent";
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
        const entry = {
          sessionId,
          updatedAt: 1,
          ...(["ordinary", "shadow-global", "unknown-shadow"].includes(sessionId)
            ? { spawnedBy: parent, status: "running" as const }
            : {}),
        };
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
      projection.selectEntries = (query) =>
        query?.parentSessionKey
          ? rows.filter((row) => row.entry.spawnedBy === query.parentSessionKey)
          : rows;
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
        const children = filterAndSortSessionEntries(
          prepareSessionRowSelection(projection, { ...prepared.opts, spawnedBy: parent }),
        );
        expect(children.map(([, entry]) => entry.sessionId)).toEqual(["ordinary"]);
      } finally {
        projection.dispose();
      }
    });
  },
);

it("rejects duplicate ordinary keys introduced after store admission before filtering or pagination", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    const primary = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const secondary = state.statePath("secondary.sqlite");
    const key = "agent:main:original";
    const parent = "agent:main:parent";
    for (const [storePath, sessionKey] of [
      [primary, key],
      [secondary, "agent:main:other"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: Date.now(),
          ...(sessionKey === key ? { parentSessionKey: parent } : {}),
        },
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
      await expect(
        listProjectedSessions({ projection, opts: { ...opts, spawnedBy: parent } }),
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

it("keeps ungrouped visible spawned work discoverable", async () => {
  const result = await listSessionFixture({
    cfg: { agents: { entries: { main: {} } } },
    storePath: "/tmp/openclaw-visible-session-activity",
    store: {
      "agent:main:subagent:hidden": {
        sessionId: "hidden",
        updatedAt: 3,
        spawnedBy: "agent:main:discussion",
      },
      "agent:main:dashboard:visible": {
        sessionId: "visible",
        updatedAt: 2,
        spawnedBy: "agent:main:discussion",
      },
      "agent:main:discussion": { sessionId: "parent", updatedAt: 1 },
    },
    opts: { excludeSubagents: true, limit: 1 },
  });
  expect(result.sessions.map((row) => row.key)).toEqual(["agent:main:dashboard:visible"]);
  expect(result).toMatchObject({ totalCount: 2, nextOffset: 1, hasMore: true });
});

it("lists indexed children without inspecting unrelated resident ownership", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const cfg = { agents: { entries: { main: {}, other: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const now = 1_790_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const parent = "agent:main:parent";
      const other = "agent:main:other";
      const key = (name: string) => `agent:main:${name}`;
      const unrelated = 96;
      const entries = new Map<string, SessionEntry>(
        Array.from({ length: unrelated }, (_, index) => [
          key(`unrelated-${index}`),
          {
            sessionId: `unrelated-${index}`,
            updatedAt: now,
            archivedAt: 1,
            parentSessionKey: key(`unrelated-parent-${index}`),
          },
        ]),
      );
      for (const [name, fields] of [
        ["spawned", { spawnedBy: parent }],
        ["dashboard:persistent", { parentSessionKey: parent, status: "done", endedAt: 1 }],
        ["expired", { spawnedBy: parent, status: "done", endedAt: 1 }],
        ["moved", { spawnedBy: parent }],
        ["runtime", {}],
      ] as const) {
        entries.set(key(name), { sessionId: name, updatedAt: now, ...fields });
      }
      const seed = (agentId: string, rows: Iterable<[string, SessionEntry]>) =>
        runOpenClawAgentWriteTransaction(
          (database) => {
            for (const [sessionKey, entry] of rows) {
              writeSessionEntry(database, sessionKey, entry, {
                canonicalPreviousEntry: null,
                previousEntry: null,
              });
            }
          },
          { agentId },
        );
      seed("main", entries);
      const crossAgent = "agent:other:child";
      seed("other", [
        [crossAgent, { sessionId: "cross-agent", updatedAt: now, spawnedBy: parent }],
      ]);
      const run = (name: string, controller: string): SubagentRunRecord => ({
        runId: name,
        childSessionKey: key(name),
        requesterSessionKey: controller === parent ? other : parent,
        controllerSessionKey: controller,
        requesterDisplayKey: "synthetic",
        task: "Synthetic child selection",
        cleanup: "keep",
        createdAt: now - 2_000,
        execution: { status: "terminal", startedAt: now - 1_500, endedAt: now - 1_000 },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      const runtime = run("runtime", parent);
      const runs = new Map([runtime, run("moved", other)].map((row) => [row.runId, row]));
      saveSubagentRegistryToSqlite(runs);
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const ownership = vi.spyOn(childOwners, "resolveSessionChildOwners");
      try {
        const opts = { spawnedBy: parent, archived: "all" as const, limit: 2 };
        const list = () => listProjectedSessions({ projection, opts });
        const first = await list();
        expect(first.sessions.map((row) => row.key)).toEqual([
          key("dashboard:persistent"),
          key("runtime"),
        ]);
        expect(first).toMatchObject({ totalCount: 4, nextOffset: 2, hasMore: true });
        const second = await listProjectedSessions({ projection, opts: { ...opts, offset: 2 } });
        expect(second.sessions.map((row) => row.key)).toEqual([key("spawned"), crossAgent]);
        expect(second).toMatchObject({ totalCount: 4, nextOffset: null, hasMore: false });
        ownership.mockClear();
        expect(await list()).toEqual(first);
        const visited = new Set(ownership.mock.calls.map(([params]) => params.key));
        ownership.mockRestore();
        const sentinel = await listProjectedSessions({
          projection,
          opts: { ...opts, spawnedBy: "global" },
        });
        expect(sentinel.sessions).toEqual([]);
        expect([...visited].filter((sessionKey) => sessionKey.includes("unrelated-")).length).toBe(
          0,
        );
        runs.set(runtime.runId, { ...runtime, controllerSessionKey: other });
        persistRegistryFixture(runs, [runtime.runId]);
        const moved = await list();
        expect(moved.sessions.map((row) => row.key)).toEqual([
          key("dashboard:persistent"),
          key("spawned"),
        ]);
        expect(moved.totalCount).toBe(3);
        runs.set(runtime.runId, {
          ...runtime,
          controllerSessionKey: undefined,
          requesterSessionKey: parent,
        });
        persistRegistryFixture(runs, [runtime.runId]);
        expect((await list()).totalCount).toBe(4);
      } finally {
        ownership.mockRestore();
        projection.dispose();
        release();
        clock.mockRestore();
      }
    },
  );
});
