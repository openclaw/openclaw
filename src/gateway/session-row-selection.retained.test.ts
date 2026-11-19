import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
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
import * as pinPolicy from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import * as sessionKeys from "../routing/session-key.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { registerRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { createSessionIdentityProjection } from "./session-identity-projection.js";
import { getSessionListBaseMiss } from "./session-list-diagnostics.js";
import * as listFilters from "./session-list-filters.js";
import type { SessionListFilteredEntries } from "./session-list-filters.js";
import { SessionListViewCache } from "./session-list-view-cache.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { shareSidebarSessionRows } from "./session-row-presentation.js";
import {
  create as createRow,
  identity,
  selectionRow,
  type EntryRow,
  create as createSessionRow,
} from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { holdSubagentExecution } from "./session-row-projection.read-fixture.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import {
  selectSessionEntries,
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareProjectedSessionList,
} from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

describe("session selection existing coverage", () => {
  const now = 1_800_000_000_000;
  const storePath = "/synthetic/retained.sqlite";
  const outsidePath = "/synthetic/outside.sqlite";
  const cfg = { agents: { entries: { main: {}, ops: {} } } };
  const agents = new Set(["main", "ops"]);

  function fixture() {
    const context = buildSessionListRowMetadataContext({ now });
    context.identityProjection = createSessionIdentityProjection();
    for (const id of ["ada", "bob"]) {
      context.userProfileIdentityById.set(id, {
        kind: "resolved",
        profileId: id,
        label: id,
        avatarUrl: "/synthetic/avatar",
      });
    }
    const create = () =>
      createSessionRowSelection(
        cfg,
        {
          agentId: undefined,
          path: storePath,
          paths: new Map([[storePath, 0]]),
          configuredAgentIds: agents,
          ownerAgentIds: agents,
        },
        false,
        () => context,
        true,
      );
    const selection = create();
    const rows = new Map<string, EntryRow>();
    const remove = (key: string) => {
      const previous = rows.get(key);
      if (previous) {
        selection.change({
          kind: "row",
          id: identity(previous),
          key,
          agentId: previous.agentId,
          storePath: previous.storeTarget.storePath,
          row: undefined,
        });
        rows.delete(key);
      }
    };
    const put = (
      key: string,
      entry: SessionEntry,
      options?: { hasBoard?: boolean; path?: string },
    ) => {
      const previous = rows.get(key);
      const agentId = key.startsWith("agent:ops:") ? "ops" : "main";
      const nextPath = options?.path ?? previous?.storeTarget.storePath ?? storePath;
      const row: EntryRow = {
        ...createRow({ key, agentId, storeTarget: { agentId, storePath: nextPath } }, entry),
        selectionSnapshot: previous?.selectionSnapshot,
        entry,
        hasBoard: options?.hasBoard ?? previous?.hasBoard ?? false,
        generation:
          previous &&
          previous.storeTarget.storePath === nextPath &&
          previous.entry.sessionId === entry.sessionId &&
          previous.entry.lifecycleRevision === entry.lifecycleRevision
            ? previous.generation
            : Symbol("generation"),
      };
      if (previous && identity(previous) !== identity(row)) {
        remove(key);
      }
      rows.set(key, row);
      selection.change({
        kind: "row",
        id: identity(row),
        key,
        agentId,
        storePath: row.storeTarget.storePath,
        row: selectionRow(row),
        scope: "session-entry",
      });
    };
    const select = (
      owner: ReturnType<typeof create>,
      opts: SessionsListParams,
      retained?: Map<object, SessionListFilteredEntries>,
    ) => {
      const selected = owner.read(opts.sortBy ?? "updatedAt");
      return selectSessionEntries({
        cfg,
        opts,
        now,
        entries: selected.entries,
        entriesSorted: true,
        partitions: selected.partitions,
        retained,
        getTarget: selected.get,
        modelSearchMayMatch: () => false,
        configuredAgentIds: selected.configuredAgentIds,
        getRowContext: () => context,
        userProfileIdentityById: context.userProfileIdentityById,
        involvementKeys: selected.involvementKeys,
        involvingActorId: opts.involvingMe ? "ada" : undefined,
        ownerFirstActorId: opts.ownerFirst ? "ada" : undefined,
        entryFilter: (_key, _entry, target) =>
          opts.hasBoard === undefined || target.hasBoard === opts.hasBoard,
      });
    };
    return {
      selection,
      rows,
      put,
      remove,
      select,
      fresh() {
        const result = create();
        for (const row of rows.values()) {
          result.add(selectionRow(row)!);
        }
        return result;
      },
    };
  }

  it("retains filtered partitions while publishing current usage and bookkeeping metadata", () => {
    const state = fixture();
    const key = "agent:main:metadata";
    const entry = { sessionId: "metadata", updatedAt: now, lastInteractionAt: now };
    state.put(key, entry);
    const retained = new Map<object, SessionListFilteredEntries>();
    const opts = { archived: "all", limit: 2 } satisfies SessionsListParams;
    state.select(state.selection, opts, retained);
    const revisions = () => state.selection.read().partitions!.map((part) => part.revision);
    const before = new Set(revisions());
    const next: SessionEntry = {
      ...entry,
      activeWriterRunId: "writer-2",
      inputTokens: 100,
      outputTokens: 20,
      cacheRead: 5,
      cacheWrite: 10,
      estimatedCostUsd: 0.001,
      contextTokens: 200,
      contextTokensSource: "runtime",
      totalTokens: 120,
      totalTokensFresh: true,
      usageReport: { state: "available" },
      activitySummary: {
        version: 1,
        text: "Synthetic activity",
        updatedAt: now + 1,
        sessionId: entry.sessionId,
        generation: null,
        maxSeq: null,
        leafEntryId: null,
        coveredMessages: 0,
        totalMessages: 0,
        omittedContent: false,
      },
      pendingFinalDelivery: { kind: "transport-only", createdAt: now },
      sessionDiffBaseline: {
        version: 1,
        sessionId: entry.sessionId,
        root: "/synthetic",
        files: [],
      },
      sessionDiffBaselineCapture: { version: 1, captureId: "capture-2", status: "pending" },
    };
    for (const published of [next, entry]) {
      state.put(key, published);
      expect(revisions().every((revision) => before.has(revision))).toBe(true);
      expect(state.select(state.selection, opts, retained).entries).toEqual([[key, published]]);
    }
    state.put(key, { ...entry, updatedAt: now + 1 });
    expect(revisions().every((revision) => before.has(revision))).toBe(false);
    expect(state.select(state.selection, opts, retained)).toEqual(
      state.select(state.fresh(), opts),
    );
  });

  it("keeps sidebar baselines when fixed query partitions advance through many revisions", () => {
    const state = fixture();
    for (let index = 0; index < 10_000; index++) {
      state.put(`agent:main:retention-${index}`, {
        sessionId: String(index),
        updatedAt: now + index,
        archivedAt: index % 2 ? 0 : undefined,
      });
    }
    const cache = new SessionListViewCache();
    const sidebar = [{ key: "retained-sidebar", kind: "direct" as const, updatedAt: now }];
    cache.setRows(cache.get("sidebar"), sidebar, true);
    const queries = [100, 150, 200, 250].map((limit) => ({ limit, archived: "all" as const }));
    const read = (opts: (typeof queries)[number]) => {
      const view = cache.get(String(opts.limit));
      view.selection = state.select(state.selection, opts, cache.partitions(view));
      cache.update(view);
      return view;
    };
    try {
      const initialBytes = queries.map((opts) => read(opts).bytes);
      const partitions = state.selection.read().partitions!.filter((part) => part.entries.size);
      const keys = partitions.map((partition) => partition.entries.keys().next().value!);
      // Keep old revision tokens live: pruning must follow the owner, never collection.
      const oldRevisions: object[] = [];
      for (let round = 0; round < 32; round++) {
        for (const [index, key] of keys.entries()) {
          oldRevisions.push(partitions[index]!.revision);
          state.put(key, { ...state.rows.get(key)!.entry, updatedAt: now + 10_000 + round });
        }
        queries.forEach(read);
      }
      expect(cache.get("sidebar").rows).toBe(sidebar);
      expect(queries.map((opts) => read(opts).bytes)).toEqual(initialBytes);
      for (const opts of queries) {
        const view = read(opts);
        expect(view.selection).toEqual(state.select(state.fresh(), opts));
        expect(oldRevisions.some((revision) => cache.partitions(view).has(revision))).toBe(false);
      }
      const emptied = partitions[0]!;
      const retired = emptied.revision;
      for (const key of emptied.entries.keys()) {
        state.remove(key);
      }
      for (const opts of queries) {
        const view = read(opts);
        expect(cache.partitions(view).has(retired)).toBe(false);
        expect(view.selection).toEqual(state.select(state.fresh(), opts));
      }
    } finally {
      cache.clear();
    }
  });

  it("keeps concurrent audience baselines under a daytime roster's selection pressure", () => {
    const state = fixture();
    for (let index = 0; index < 60_000; index++) {
      state.put(`agent:main:${index % 5 ? "subagent:" : ""}day-${index}`, {
        sessionId: String(index),
        updatedAt: now + index,
        lastInteractionAt: now + index,
        createdActor: { type: "human", source: "profile", id: index % 2 ? "ada" : "bob" },
        ...(index % 5 ? { parentSessionKey: "agent:main:day-0" } : {}),
        ...(index % 7 === 0 ? { archivedAt: now - 1000 } : {}),
      });
    }
    const queries = new Map<string, SessionsListParams>();
    // Seventy connections share 22 audiences; equal audience/query keys share a view.
    for (let connection = 0; connection < 70; connection++) {
      for (const sortBy of ["updatedAt", "lastInteractionAt", "activity"] as const) {
        queries.set(`${connection % 22}:${sortBy}`, { sortBy, archived: "all", limit: 200 });
      }
      queries.set(`${connection % 22}:counts`, {
        limit: 1,
        includeOwnerSessionCounts: true,
        excludeSubagents: true,
        excludeCron: true,
        excludeSystem: true,
        excludeDock: true,
      });
    }
    const cache = new SessionListViewCache();
    const controls = new Map<string, SessionListViewCache>();
    const baselines = new Map<string, string>();
    const presented = new WeakMap<SessionEntry, GatewaySessionRow>();
    let unknownBases = 0;
    const differentReplies: string[] = [];
    try {
      for (let round = 0; round < 2; round++) {
        if (round) {
          const key = "agent:main:subagent:day-59999";
          state.put(key, { ...state.rows.get(key)!.entry, updatedAt: now + 60_000 });
        }
        for (const [key, opts] of queries) {
          const selection = cache.get(`selection:${key}`);
          selection.selection = state.select(state.selection, opts, cache.partitions(selection));
          cache.update(selection);
          if (opts.includeOwnerSessionCounts) {
            expect(selection.selection.ownerSessionCounts?.length).toBe(2);
            continue;
          }
          const rows = selection.selection.entries.map(([rowKey, entry]) => {
            let row = presented.get(entry);
            if (!row) {
              row = Object.freeze({ key: rowKey, kind: "direct", updatedAt: entry.updatedAt });
              presented.set(entry, row);
            }
            return row;
          });
          const view = cache.get(`rows:${key}`);
          cache.setRows(view, rows, true);
          const control = controls.get(key) ?? new SessionListViewCache();
          controls.set(key, control);
          const witness = control.get(key);
          control.setRows(witness, rows, true);
          const baseline = baselines.get(key);
          const actual = shareSidebarSessionRows(rows, baseline, view.rowHistory);
          const expected = shareSidebarSessionRows(rows, baseline, witness.rowHistory);
          if (round) {
            unknownBases += Number(getSessionListBaseMiss(actual) === "unknown-base");
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              differentReplies.push(key);
            }
            expect(expected.rowsDelta?.order).toHaveLength(200);
            expect(expected.sessions).toHaveLength(1);
          }
          baselines.set(key, `delta:${actual.rowsRevision}`);
        }
      }
      expect(unknownBases).toBe(0);
      expect(differentReplies).toEqual([]);
    } finally {
      cache.clear();
      controls.forEach((control) => control.clear());
    }
  });

  it("streams owner counts through archive partitions and trusts admitted agent identities", () => {
    const state = fixture();
    for (let index = 0; index < 1024; index++) {
      state.put(`agent:main:stream-${index}`, {
        sessionId: String(index),
        updatedAt: index,
        archivedAt: index % 2 ? 0 : undefined,
      });
    }
    state.put("agent:ops:other-agent", { sessionId: "other-agent", updatedAt: now });
    const partitions = state.selection.read().partitions!;
    const largestPartition = Math.max(...partitions.map((part) => part.entries.size));
    let archived: boolean | "all" = false;
    let read = 0;
    const spies = partitions.flatMap((part) => {
      const visit = (entry: SessionEntry) => {
        expect(entry.archivedAt !== undefined).toBe(part.archived);
        expect(archived === "all" || part.archived === archived).toBe(true);
        read++;
      };
      const each = part.entries.forEach.bind(part.entries);
      const direct = vi.spyOn(part.entries, "forEach").mockImplementation((callback) => {
        each((pair, key, map) => {
          visit(pair[1]);
          callback(pair, key, map);
        });
      });
      const values = part.entries.values.bind(part.entries);
      const iterated = vi.spyOn(part.entries, "values").mockImplementation(function* () {
        for (const pair of values()) {
          visit(pair[1]);
          yield pair;
        }
        return undefined;
      });
      return [direct, iterated];
    });
    let filtered = 0;
    const filter = listFilters.filterSessionEntries;
    using normalized = vi.spyOn(sessionKeys, "normalizeAgentId");
    using _ = vi.spyOn(listFilters, "filterSessionEntries").mockImplementation((params) => {
      expect(read).toBe(filtered);
      const result = filter(params);
      expect(read - filtered).toBeLessThanOrEqual(largestPartition);
      filtered = read;
      return result;
    });
    try {
      for (archived of [false, true, "all"] as const) {
        read = filtered = 0;
        const result = state.select(
          state.selection,
          { archived, limit: 10, agentId: " MAIN ", includeOwnerSessionCounts: true },
          new Map(),
        );
        expect(result.totalCount).toBe(archived === "all" ? 1024 : 512);
        expect(read).toBe(result.totalCount + Number(archived !== true));
        expect(new Set(normalized.mock.calls.map(([id]) => id))).toEqual(new Set([" MAIN "]));
        expect(result.entries.map(([, entry]) => entry.sessionId)).toEqual(
          Array.from({ length: 10 }, (_value, index) =>
            String(1023 - Number(archived === false) - index * (archived === "all" ? 1 : 2)),
          ),
        );
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("reads only the requested page from retained ordered partitions", () => {
    const state = fixture();
    const count = 10_800;
    for (let index = 0; index < count; index++) {
      state.put(`agent:main:page-${index}`, {
        sessionId: String(index),
        updatedAt: now + index,
        pinnedAt: now + index,
        createdActor: { type: "human", source: "profile", id: index % 2 ? "bob" : "ada" },
      });
    }
    for (const opts of [
      { limit: 200, offset: 7 },
      { limit: 200, ownerFirst: true },
    ]) {
      const retained = new Map<object, SessionListFilteredEntries>();
      state.select(state.selection, opts, retained);
      const reads = { entries: 0, ownerEntries: 0 };
      for (const part of retained.values()) {
        for (const field of ["entries", "ownerEntries"] as const) {
          part[field] = new Proxy(part[field], {
            get(target, key, receiver) {
              if (typeof key === "string" && /^\d+$/.test(key)) {
                reads[field]++;
              }
              return Reflect.get(target, key, receiver);
            },
          });
        }
      }
      using pins = vi.spyOn(pinPolicy, "isPinnableSessionEntry");
      const result = state.select(state.selection, opts, retained);
      const shared = Array.from(
        { length: opts.limit },
        (_, i) => count - 1 - (opts.offset ?? 0) - i,
      );
      const owned = opts.ownerFirst ? Array.from({ length: 60 }, (_, i) => count - 2 - i * 2) : [];
      expect(result.entries.map(([, entry]) => entry.sessionId)).toEqual(
        [...owned, ...shared.filter((index) => !owned.includes(index))].map(String),
      );
      expect(result).toMatchObject({
        totalCount: count,
        ownerCount: owned.length,
        hasMore: true,
        nextOffset: (opts.offset ?? 0) + opts.limit,
      });
      expect(result.ownerFacet.map((owner) => owner.id)).toEqual(["ada", "bob"]);
      expect(reads.entries).toBeLessThanOrEqual((opts.offset ?? 0) + opts.limit + retained.size);
      expect(reads.ownerEntries).toBeLessThanOrEqual(owned.length + retained.size);
      expect(pins).toHaveBeenCalledTimes(reads.entries + reads.ownerEntries);
    }
  });

  it.for([0x12e7, 0x4b91])("matches fresh selection after seeded write sequences (%i)", (seed) => {
    const state = fixture();
    let randomState = seed;
    const random = (limit: number) => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return (randomState >>> 8) % limit;
    };
    const keys = Array.from({ length: 96 }, (_, index) =>
      index === 0
        ? "global"
        : index === 1
          ? "unknown"
          : index === 2
            ? "agent:main:cron:fixture"
            : `agent:${index % 3 === 0 ? "ops" : "main"}:row-${index}`,
    );
    const initial = (key: string, index: number): SessionEntry => ({
      sessionId: `${key}-session`,
      updatedAt: now - index * 60_000,
      createdAt: now - index * 60_000,
      lastInteractionAt: index % 4 ? now - index * 60_000 : undefined,
      label: index % 2 ? "alpha" : "beta",
      category: index % 2 ? "work" : "personal",
      projectId: index % 2 ? "one" : "two",
      spawnedWorkspaceDir: index % 2 ? "/one" : "/two",
      boardFace: index % 2 ? "chat" : "dashboard",
      createdActor: { type: "human", source: "profile", id: index % 2 ? "ada" : "bob" },
      participants: [{ identity: { type: "profile", id: index % 2 ? "ada" : "bob" } }],
    });
    for (const [index, key] of keys.entries()) {
      state.put(key, initial(key, index));
    }
    const queries: SessionsListParams[] = [
      ...(["updatedAt", "lastInteractionAt", "activity"] as const).map((sortBy) => ({
        sortBy,
        limit: 1,
      })),
      ...(["updatedAt", "lastInteractionAt", "activity"] as const).flatMap((sortBy) =>
        ([false, true, "all"] as const).map((archived) => ({
          sortBy,
          archived,
          limit: 5,
          offset: 2,
        })),
      ),
      ...([
        { label: "alpha" },
        { search: "alpha" },
        { search: "nonexistent" },
        { boardFace: "dashboard" },
        { group: "work" },
        { projectId: "one" },
        { workspaceDir: "/one" },
        { requireLastInteraction: true },
        { pinned: true },
        { agentId: "ops" },
        { excludeSystem: true, excludeDock: true, excludeSubagents: true, excludeCron: true },
        { hasBoard: true },
        { creatorId: "ada", ownerFirst: true },
        { ownerId: "bob", involvingMe: true },
        { profileRelation: { profileId: "ada", relationship: "involving" } },
        { profileRelation: { profileId: "bob", relationship: "owned" } },
        { activeMinutes: 15, sortBy: "activity" },
      ] satisfies SessionsListParams[]),
    ].map((query): SessionsListParams =>
      Object.assign(
        {
          archived: "all",
          limit: 7,
          includeGlobal: true,
          includeUnknown: true,
          includeOwnerSessionCounts: true,
        } satisfies SessionsListParams,
        query,
      ),
    );
    const retained = queries.map(() => new Map<object, SessionListFilteredEntries>());
    const check = () => {
      const fresh = state.fresh();
      for (const [index, query] of queries.entries()) {
        expect(state.select(state.selection, query, retained[index])).toEqual(
          state.select(fresh, query),
        );
      }
      for (const profileId of ["ada", "bob"]) {
        expect([...state.selection.createdEntries(new Set([profileId]))]).toEqual([
          ...fresh.createdEntries(new Set([profileId])),
        ]);
      }
    };
    check();
    for (let step = 0; step < 72; step++) {
      const index = random(keys.length);
      const key = keys[index]!;
      const previous = state.rows.get(key);
      const entry = previous?.entry ?? initial(key, index);
      const value = random(2) === 0;
      const operation = random(22);
      if (operation === 0) {
        state.remove(key);
      } else if (operation >= 20) {
        state.put(
          key,
          entry,
          operation === 20 ? { hasBoard: value } : { path: value ? storePath : outsidePath },
        );
      } else {
        const patches: Partial<SessionEntry>[] = [
          { updatedAt: now + step + 1 },
          { lastInteractionAt: value ? now + step + 1 : undefined },
          { lastActivityAt: value ? now + step + 1 : undefined },
          { archivedAt: value ? 0 : undefined },
          {
            pinnedAt: value ? now + step : undefined,
            sidebarRoot: value,
            parentSessionKey: keys[4],
          },
          { label: value ? "alpha" : "beta" },
          { category: value ? "work" : "personal" },
          { projectId: value ? "one" : "two" },
          { spawnedCwd: value ? "/one" : undefined, spawnedWorkspaceDir: "/two" },
          { boardFace: value ? "chat" : "dashboard" },
          {
            createdActor: value
              ? { type: "human", source: "profile", id: "ada" }
              : { type: "system", id: "fixture" },
          },
          { owner: { actor: { type: "human", id: value ? "ada" : "bob" } } },
          { participants: value ? [{ identity: { type: "profile", id: "ada" } }] : [] },
          {
            profileInvolvement: {
              key,
              profiles: { ada: { hidden: value, updatedAt: now + step } },
            },
          },
          { heartbeatIsolatedBaseSessionKey: value ? keys[4] : undefined },
          {
            createdSurface: value ? "plugin-dock" : undefined,
            spawnedBy: value ? keys[4] : undefined,
          },
          {
            sessionId: `${key}-replacement-${step}`,
            lifecycleRevision: `generation-${step}`,
          },
          {
            inputTokens: step,
            estimatedCostUsd: step / 100,
            activeWriterRunId: `writer-${step}`,
          },
          {
            startedAt: now + step,
            abortedLastRun: value,
            pendingFinalDelivery: value
              ? { kind: "transport-only", createdAt: now + step }
              : undefined,
          },
        ];
        state.put(key, { ...entry, ...patches[operation - 1] });
      }
      check();
    }
  });
});

describe("session selection retained boundaries", () => {
  type ListOptions = Parameters<typeof listProjectedSessions>[0];
  const listRows = (
    projection: ListOptions["projection"],
    opts: ListOptions["opts"],
    key?: string,
  ) => listProjectedSessions({ projection, opts, key });

  function writeMain(sessionKey: string, entry: Partial<SessionEntry>) {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId: sessionKey, updatedAt: 1, ...entry },
    );
  }

  const rowKeys = (result: Awaited<ReturnType<typeof listProjectedSessions>>) =>
    result.sessions.map((row) => row.key);

  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("selects canonical participant involvement without reading display fields", () => {
    const cfg = { agents: { entries: { main: {} } } };
    const context = buildSessionListRowMetadataContext({ now: 1 });
    context.identityProjection = createSessionIdentityProjection();
    for (const [id, profileId] of [
      ["alias", "ada"],
      ["ada", "ada"],
      ["bob", "bob"],
    ] as const) {
      context.userProfileIdentityById.set(id, {
        kind: "resolved",
        profileId,
        label: "Participant display",
        avatarUrl: "/synthetic/avatar",
      });
    }
    const storePath = "/synthetic/involvement.sqlite";
    const agents = new Set(["main"]);
    const selection = createSessionRowSelection(
      cfg,
      {
        path: storePath,
        paths: new Map([[storePath, 0]]),
        agentId: "main",
        configuredAgentIds: agents,
        ownerAgentIds: agents,
      },
      false,
      () => context,
    );
    const key = "agent:main:participants";
    const put = (entry: SessionEntry) =>
      selection.add({
        ...createSessionRow(
          { key, agentId: "main", storeTarget: { agentId: "main", storePath } },
          entry,
        ),
        entry,
      });
    const entry: SessionEntry = {
      sessionId: key,
      updatedAt: 1,
      participants: [
        { identity: { type: "profile", id: "alias" } },
        { identity: { type: "profile", id: "ada" } },
        { identity: { type: "agent", id: "main" } },
        { identity: { type: "legacy", actorType: "human", source: null, id: "bob" } },
      ],
      profileInvolvement: {
        key,
        profiles: { ada: { hidden: true, updatedAt: 1 }, bob: { hidden: false, updatedAt: 1 } },
      },
    };
    put(entry);
    const keys = (id: string, personal: boolean) => [
      ...selection.read().involvementKeys(id, personal),
    ];
    expect(keys("ada", false)).toEqual([key]);
    expect(keys("ada", true)).toEqual([]);
    expect(keys("bob", false)).toEqual([]);
    expect(keys("bob", true)).toEqual([key]);
    // Profile merges and entry replacement must retire the old membership.
    context.userProfileIdentityById.set("alias", {
      kind: "resolved",
      profileId: "bob",
      avatarUrl: "/synthetic/avatar",
    });
    context.identityProjection.invalidate();
    expect(keys("bob", false)).toEqual([key]);
    put({ ...entry, participants: [], profileInvolvement: undefined });
    expect(keys("ada", false)).toEqual([]);
    expect(keys("bob", true)).toEqual([]);
  });

  it("filters active sentinels only after selecting their physical store winner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {}, ops: {} } } };
      const projection = createSessionRowProjectionFixture({ cfg, store: {} });
      const samples = [
        ["shadow-global", "global", "main", "fallback"],
        ["main-global", "global", "main", "primary"],
        ["ops-global", "global", "ops", "primary"],
        ["ops-shadow", "global", "ops", "fallback"],
        ["unknown-winner", "unknown", "ops", "primary"],
        ["unknown-shadow", "unknown", "main", "fallback"],
      ] as const;
      const rows = samples.map(([sessionId, key, agentId, storePath]) => {
        const entry = { sessionId, updatedAt: 1 };
        return {
          ...createSessionRow({ key, agentId, storeTarget: { agentId, storePath } }, entry),
          entry,
        };
      });
      projection.selectEntries = (query) => {
        const identities = query?.candidateSessionIdsOrKeys;
        if (!identities) {
          return rows;
        }
        const keys = new Set(
          rows
            .filter((row) => identities.has(row.key) || identities.has(row.entry.sessionId))
            .map((row) => row.key),
        );
        return rows.filter((row) => keys.has(row.key));
      };
      projection.state.scope = () => ({
        targets: rows.map((row) => row.storeTarget),
        paths: new Map([
          ["primary", 0],
          ["fallback", 1],
        ]),
        path: "(multiple)",
        agentId: undefined,
        configuredAgentIds: new Set(["main", "ops"]),
        ownerAgentIds: new Set(["main", "ops"]),
      });
      const registrations = await Promise.all(
        [
          ["main", "shadow-global"],
          ["ops", "ops-global"],
          ["main", "unknown-shadow"],
        ].map(async ([agentId, sessionId]) => {
          const registration = registerRpcSourceForTest({
            storeScope: samples.find(([id]) => id === sessionId)![3],
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
          context: requestContext(cfg),
          opts: {
            activeOnly: true,
            configuredAgentsOnly: true,
            includeGlobal: true,
            includeUnknown: true,
          },
          now: Date.now(),
          metadataPrepared: true,
        });
        // An active fallback cannot displace its inactive winner; other agents remain visible.
        expect(filterAndSortSessionEntries(filters).map(([, entry]) => entry.sessionId)).toEqual([
          "ops-global",
          "unknown-shadow",
        ]);
      } finally {
        for (const registration of registrations) {
          registration.release();
          registration.cleanup();
        }
        projection.dispose();
      }
    });
  });

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
        expect((await listRows(projection, opts)).sessions).toHaveLength(2);
        const duplicate = { agentId: "main", storePath: secondary, sessionKey: key };
        replaceSessionEntrySync(duplicate, { sessionId: "duplicate", updatedAt: Date.now() + 1 });
        await expect(listRows(projection, { ...opts, limit: 1, offset: 1 })).rejects.toThrow(
          "duplicate rows resolve to canonical session key",
        );
        await expect(listRows(projection, { ...opts, spawnedBy: parent })).rejects.toThrow(
          "duplicate rows resolve to canonical session key",
        );
        await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: secondary,
          archiveTranscript: false,
          target: { canonicalKey: key, storeKeys: [key] },
        });
        const result = await listRows(projection, opts);
        expect(rowKeys(result).toSorted()).toEqual([key, "agent:main:other"]);
      } finally {
        projection.dispose();
      }
    });
  });

  it("pages children by their current controller and retains persistent children", async () => {
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
        for (const [name, fields] of [
          ["spawned", { spawnedBy: parent }],
          ["dashboard:persistent", { parentSessionKey: parent, status: "done", endedAt: 1 }],
          ["expired", { spawnedBy: parent, status: "done", endedAt: 1 }],
          ["moved", { spawnedBy: parent }],
          ["runtime", {}],
        ] as const) {
          writeMain(key(name), { sessionId: name, updatedAt: now, ...fields });
        }
        const crossAgent = "agent:other:child";
        replaceSessionEntrySync(
          { agentId: "other", sessionKey: crossAgent },
          { sessionId: "cross-agent", updatedAt: now, spawnedBy: parent },
        );
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
        try {
          const opts = { spawnedBy: parent, archived: "all" as const, limit: 2 };
          const list = () => listRows(projection, opts);
          const first = await list();
          expect(rowKeys(first)).toEqual([key("dashboard:persistent"), key("runtime")]);
          expect(first).toMatchObject({ totalCount: 4, nextOffset: 2, hasMore: true });
          const second = await listRows(projection, { ...opts, offset: 2 });
          expect(rowKeys(second)).toEqual([key("spawned"), crossAgent]);
          expect(second).toMatchObject({ totalCount: 4, nextOffset: null, hasMore: false });
          const sentinel = await listRows(projection, { ...opts, spawnedBy: "global" });
          expect(sentinel.sessions).toEqual([]);
          runs.set(runtime.runId, { ...runtime, controllerSessionKey: other });
          subagentRuns.set(runtime.runId, runs.get(runtime.runId)!);
          persistRegistryFixture(runs, [runtime.runId]);
          const moved = await list();
          expect(rowKeys(moved)).toEqual([key("dashboard:persistent"), key("spawned")]);
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
});
