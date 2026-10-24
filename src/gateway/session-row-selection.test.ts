import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import {
  persistRegistryFixture,
  saveSubagentRegistryToSqlite,
} from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { registerRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { indexSessionRow } from "./session-row-projection-identities.js";
import {
  create as createSessionRow,
  identity,
  type Query,
  type Row,
} from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { holdSubagentExecution } from "./session-row-projection.read-fixture.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { createSessionRowEntrySelector, selectMatchingSessionRows } from "./session-row-scope.js";
import * as childOwners from "./session-utils-core.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareProjectedSessionList,
  prepareSessionRowSelection,
} from "./session-utils-list.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

it("preserves scoped key and ID selection against a scan over randomized federated rows", () => {
  let seed = 1467;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  const cfg = { agents: { entries: { main: {}, work: {}, other: {} } } };
  const agents = Object.keys(cfg.agents.entries);
  const paths = ["/synthetic/a", "/synthetic/b", "/synthetic/c"];
  const scope = {
    physicalPaths: (locator: string, agentId?: string) =>
      locator === "/synthetic/shared"
        ? agentId
          ? [paths[agents.indexOf(agentId)]!]
          : paths
        : [locator],
  };
  for (let fixture = 0; fixture < 20; fixture++) {
    const rows = new Map<string, Row>();
    for (let index = 0; index < 80; index++) {
      const agentId = agents[random(agents.length)]!;
      const key = ["global", "unknown", `agent:${agentId}:key-${random(12)}`][random(3)]!;
      const entry = { sessionId: `id-${random(12)}`, updatedAt: random(10) };
      const row = {
        ...createSessionRow({
          key,
          agentId,
          storeTarget: {
            agentId: agents[random(agents.length)]!,
            storePath: paths[random(paths.length)]!,
          },
        }),
        entry,
      };
      rows.set(identity(row), row);
    }
    const indexes = {
      byKey: new Map<string, Set<string>>(),
      byAgent: new Map<string, Set<string>>(),
      byStore: new Map<string, Set<string>>(),
      byParent: new Map<string, Set<string>>(),
    };
    for (const row of rows.values()) {
      indexSessionRow(row, indexes);
    }
    const matching = (query: Query, kind?: string) =>
      selectMatchingSessionRows({ rows, indexes, scope }, query, kind);
    const select = createSessionRowEntrySelector({
      isActive: () => true,
      runAsOwner: (read) => read(),
      prepare: () => true,
      state: () => ({
        cfg,
        scope,
        ...indexes,
        rows,
        dirty: new Set<string>(),
        hasUnresolvedCategories: false,
        matching,
        acquire: (row) => row,
        referenced: () => undefined,
      }),
    });
    // The reference scans rows, independent of the production candidate indexes.
    const scan = (query: Query, kind = "key") => {
      const selectedPaths = query.storePath
        ? scope.physicalPaths(query.storePath, query.agentId)
        : undefined;
      const candidates =
        !query.key && selectedPaths
          ? selectedPaths.flatMap((pathname) =>
              [...rows.values()].filter((row) => row.storeTarget.storePath === pathname),
            )
          : [...rows.values()];
      return candidates.filter(
        (row) =>
          (!query.key || (kind === "id" ? row.entry?.sessionId : row.key) === query.key) &&
          (!query.agentId ||
            row.agentId === query.agentId ||
            ((query.key || selectedPaths) && row.storeTarget.agentId === query.agentId)) &&
          (!selectedPaths || selectedPaths.includes(row.storeTarget.storePath)),
      );
    };
    for (let sample = 0; sample < 40; sample++) {
      const query: Query = {
        agentId: [...agents, undefined][random(4)],
        storePath: [...paths, "/synthetic/shared", undefined][random(5)],
        sortBy: null,
        ...(random(2)
          ? { sessionIdOrKey: random(2) ? `id-${random(12)}` : "global" }
          : { key: random(2) ? `agent:main:key-${random(12)}` : undefined }),
      };
      expect(matching(query).map(identity)).toEqual(scan(query).map(identity));
      const indexed = { ...query, key: query.sessionIdOrKey };
      const keys = new Set([...scan(indexed, "id"), ...scan(indexed)].map((row) => row.key));
      const expected = (
        query.sessionIdOrKey ? [...keys].flatMap((key) => scan({ ...query, key })) : scan(query)
      ).filter((row) => !query.agentId || row.agentId === query.agentId);
      expect(select(query).map(identity)).toEqual(expected.map(identity));
    }
  }
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
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3 },
      );
      expect((await list())[0]?.key).toBe(third);
      expect(await listProjectedSessions({ projection, opts: { archived: true } })).toMatchObject({
        sessions: [],
        totalCount: 0,
      });
      // Archive membership is presence, including a zero timestamp.
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: third },
        { sessionId: third, updatedAt: 4, lastInteractionAt: 3, archivedAt: 0 },
      );
      expect((await list())[0]?.key).toBe(second);
      expect(
        await listProjectedSessions({ projection, opts: { archived: true, limit: 1 } }),
      ).toMatchObject({ sessions: [{ key: third }], totalCount: 1, hasMore: false });
      const archivedQuery = { agentId: "main", key: third };
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.capture(archivedQuery)?.materialized).toBeUndefined();
      const rematerialized = await listProjectedSessions({
        projection,
        opts: { archived: true },
      });
      expect(rematerialized.sessions.map((row) => row.key)).toEqual([third]);
      expect(rematerialized.totalCount).toBe(1);
      expect(projection.capture(archivedQuery)?.materialized).toBeDefined();
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
      // A retained pin becomes effective only when the child is a sidebar root.
      for (const sidebarRoot of [false, true, false]) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: first },
          {
            sessionId: first,
            updatedAt: 2,
            lastInteractionAt: 1,
            pinnedAt: 10,
            parentSessionKey: second,
            sidebarRoot,
          },
        );
        expect((await list())[0]?.key).toBe(sidebarRoot ? first : second);
        expect(
          (await listProjectedSessions({ projection, opts: { pinned: true } })).sessions.map(
            (row) => row.key,
          ),
        ).toEqual(sidebarRoot ? [first] : []);
      }
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

it("refreshes agent owner facets when the sidebar roster changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg: OpenClawConfig = {
      agents: { entries: { main: {}, owner: {} } },
      acp: { allowedAgents: ["transport"] },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:owned";
    const entry = {
      sessionId: "owned",
      updatedAt: 1,
    };
    replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
    assignSessionOwner(
      { agentId: "main", sessionKey: key },
      { owner: { type: "agent", id: "owner" }, assignedBy: { type: "system", id: "test" } },
    );
    const acpKey = "agent:main:acp-owner";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: acpKey },
      { sessionId: "acp-owner", updatedAt: 2, archivedAt: 3 },
    );
    assignSessionOwner(
      { agentId: "main", sessionKey: acpKey },
      { owner: { type: "agent", id: "transport" }, assignedBy: { type: "system", id: "test" } },
    );
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      modelCatalog: [],
    });
    try {
      const list = (scoped = true) =>
        listProjectedSessions({
          projection,
          opts: {
            agentId: scoped ? "main" : undefined,
            configuredAgentsOnly: true,
            includeGlobal: true,
            includeUnknown: true,
            rowMode: "sidebar",
            limit: 200,
            archived: "all",
          },
        });
      // Read the cold ACP row before a scoped read can populate its owner projection.
      expect((await list(false)).owners?.map(({ id }) => id)).toEqual(["owner"]);
      expect((await list()).owners?.map(({ id }) => id)).toEqual(["owner"]);
      await patchSessionEntryCore({ agentId: "main", sessionKey: key }, () => ({
        label: "Metadata changed",
      }));
      expect((await list()).owners?.map(({ id }) => id)).toEqual(["owner"]);
      cfg = { ...cfg, agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).owners).toEqual([]);
      expect((await list(false)).owners).toEqual([]);
      cfg = { ...cfg, agents: { entries: { main: {}, owner: {} } } };
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).owners?.map(({ id }) => id)).toEqual(["owner"]);
      expect((await list(false)).owners?.map(({ id }) => id)).toEqual(["owner"]);
    } finally {
      projection.dispose();
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
      const now = Date.now();
      projection.state.rowContext.subagentRuns = buildSubagentRunReadIndexFromRuns({
        now,
        runs: new Map<string, SubagentRunRecord>([
          [
            "ordinary-run",
            {
              runId: "ordinary-run",
              childSessionKey: "agent:main:ordinary",
              requesterSessionKey: parent,
              requesterDisplayKey: parent,
              task: "Synthetic child selection",
              cleanup: "keep",
              createdAt: now,
              execution: { status: "running", startedAt: now },
            },
          ],
        ]),
      });
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
            ? { spawnedBy: parent }
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
      projection.selectEntries = (query) => {
        if (query?.sessionIdOrKey) {
          const keys = new Set(
            rows
              .filter(
                (row) =>
                  row.key === query.sessionIdOrKey || row.entry.sessionId === query.sessionIdOrKey,
              )
              .map((row) => row.key),
          );
          return rows.filter((row) => keys.has(row.key));
        }
        return query?.parentSessionKey
          ? rows.filter((row) => row.entry.spawnedBy === query.parentSessionKey)
          : rows;
      };
      projection.state.scope = () => ({
        paths: new Map([
          ["primary", 0],
          ["fallback", 1],
        ]),
        path: "(multiple)",
        agentId: undefined,
        configuredAgentIds: new Set(["main", "ops"]),
        ownerAgentIds: new Set(["main", "ops"]),
      });
      try {
        const prepared = prepareSessionRowSelection(projection, {
          activeOnly,
          configuredAgentsOnly: true,
          includeGlobal: true,
          includeUnknown: true,
        });
        expect(prepared.entries("all").map(([, entry]) => entry.sessionId)).toEqual(
          activeOnly
            ? ["ordinary", "main-global", "ops-global", "unknown-winner", "unknown-shadow"]
            : ["ordinary", "main-global", "unknown-winner"],
        );
        for (const [key, entry] of prepared.entries("all")) {
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
        if (activeOnly) {
          const context = requestContext(cfg);
          const registrations = await Promise.all(
            [
              ["main", "shadow-global"],
              ["ops", "ops-global"],
              ["main", "unknown-shadow"],
            ].map(async ([agentId, sessionId]) => {
              const registration = registerRpcSourceForTest({
                storeScope: samples.find(([sampleId]) => sampleId === sessionId)![3],
                runId: sessionId!,
                agentId,
                sessionId: sessionId!,
                sessionKey: `agent:${agentId}:run-alias:${sessionId}`,
              });
              const release = await claimRpcSourceForTest(registration.entry!);
              return Object.assign({}, registration, { release });
            }),
          );
          try {
            const { filters } = prepareProjectedSessionList({
              projection,
              context,
              opts: prepared.opts,
              now,
              metadataPrepared: true,
            });
            // The live fallback ID cannot displace its inactive physical winner.
            // Other agents' sentinel rows and same-ID aliases remain independently visible.
            expect(
              filterAndSortSessionEntries(filters).map(([, entry]) => entry.sessionId),
            ).toEqual(["ops-global", "unknown-shadow"]);
          } finally {
            for (const registration of registrations) {
              registration.release();
              registration.cleanup();
            }
          }
        }
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
        execution: { status: "running", startedAt: now - 1_500 },
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      const runtime = run("runtime", parent);
      const runs = new Map([runtime, run("moved", other)].map((row) => [row.runId, row]));
      using runtimeExecution = holdSubagentExecution(runtime.runId, runtime.childSessionKey);
      using movedExecution = holdSubagentExecution("moved", key("moved"));
      for (const controlledRun of runs.values()) {
        subagentRuns.set(controlledRun.runId, controlledRun);
      }
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
        subagentRuns.set(runtime.runId, runs.get(runtime.runId)!);
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
        subagentRuns.set(runtime.runId, runs.get(runtime.runId)!);
        persistRegistryFixture(runs, [runtime.runId]);
        expect((await list()).totalCount).toBe(4);
      } finally {
        ownership.mockRestore();
        projection.dispose();
        runtimeExecution[Symbol.dispose]();
        movedExecution[Symbol.dispose]();
        for (const runId of runs.keys()) {
          subagentRuns.delete(runId);
        }
        release();
        clock.mockRestore();
      }
    },
  );
});
