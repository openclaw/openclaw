import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
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
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { registerRpcSourceForTest } from "./server-methods/rpc-source-fixtures.test-support.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { holdSubagentExecution } from "./session-row-projection.read-fixture.test-support.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareProjectedSessionList,
} from "./session-utils-list.js";
import { claimRpcSourceForTest } from "./test-helpers.rpc-source.js";

type ListOptions = Parameters<typeof listProjectedSessions>[0];
const listRows = (projection: ListOptions["projection"], opts: ListOptions["opts"], key?: string) =>
  listProjectedSessions({ projection, opts, key });

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

it("maintains list order across metadata changes and archived-row rematerialization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const first = "agent:main:first";
    const second = "agent:main:second";
    for (const [sessionKey, updatedAt, lastInteractionAt] of [
      [first, 2, 1],
      [second, 1, 2],
    ] as const) {
      writeMain(sessionKey, { updatedAt, lastInteractionAt });
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      const list = async (sortBy?: "lastInteractionAt" | "activity") =>
        (await listRows(projection, { limit: 1, sortBy })).sessions;
      expect((await list())[0]?.key).toBe(first);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(second);
      expect((await list("activity"))[0]?.key).toBe(second);
      expect((await list())[0]?.key).toBe(first);
      writeMain(second, { updatedAt: 3, label: "Changed metadata" });
      expect((await list())[0]).toMatchObject({ key: second, label: "Changed metadata" });
      const third = "agent:main:third";
      writeMain(third, { updatedAt: 4, lastInteractionAt: 3 });
      expect((await list())[0]?.key).toBe(third);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(third);
      expect(await listRows(projection, { limit: 1, offset: 1 })).toMatchObject({
        totalCount: 3,
        nextOffset: 2,
        hasMore: true,
        sessions: [{ key: second }],
      });
      // Archive membership is presence, including a zero timestamp.
      writeMain(third, { updatedAt: 4, lastInteractionAt: 3, archivedAt: 0 });
      expect((await list())[0]?.key).toBe(second);
      expect(await listRows(projection, { archived: true, limit: 1 })).toMatchObject({
        sessions: [{ key: third }],
        totalCount: 1,
        hasMore: false,
      });
      const archivedQuery = { agentId: "main", key: third };
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.capture(archivedQuery)?.materialized).toBeUndefined();
      const rematerialized = await listRows(projection, { archived: true });
      expect(rowKeys(rematerialized)).toEqual([third]);
      expect(rematerialized.totalCount).toBe(1);
      expect(projection.capture(archivedQuery)?.materialized).toBeDefined();
      expect((await list())[0]?.key).toBe(second);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: projection.capture({ agentId: "main", key: third })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: third, storeKeys: [third] },
      });
      const remaining = await listRows(projection, { archived: "all", sortBy: "activity" });
      expect(rowKeys(remaining)).toEqual([second, first]);
      expect(remaining).toMatchObject({ totalCount: 2, nextOffset: null, hasMore: false });
      writeMain(first, { updatedAt: 2, lastInteractionAt: 1, pinnedAt: 10 });
      expect((await list())[0]?.key).toBe(first);
      expect((await list("activity"))[0]?.key).toBe(second);
      expect((await list("lastInteractionAt"))[0]?.key).toBe(first);
      // A retained pin becomes effective only when the child is a sidebar root.
      for (const sidebarRoot of [false, true, false]) {
        writeMain(first, {
          updatedAt: 2,
          lastInteractionAt: 1,
          pinnedAt: 10,
          parentSessionKey: second,
          sidebarRoot,
        });
        expect((await list())[0]?.key).toBe(sidebarRoot ? first : second);
        expect(
          (await listRows(projection, { pinned: true })).sessions.map((row) => row.key),
        ).toEqual(sidebarRoot ? [first] : []);
      }
      writeMain(first, { updatedAt: 2, lastInteractionAt: 1, label: "Unpinned" });
      expect((await list())[0]?.key).toBe(second);
      projection.onSelectionChange(() => {
        throw new Error("Synthetic selection observer failure");
      });
      writeMain(first, { updatedAt: 5, label: "Changed despite observer failure" });
      expect((await list())[0]).toMatchObject({
        key: first,
        label: "Changed despite observer failure",
      });
      projection.dispose();
      expect(projection.selectEntries()).toEqual([]);
    } finally {
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
    writeMain(acpKey, { sessionId: "acp-owner", updatedAt: 2, archivedAt: 3 });
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
        listRows(projection, {
          agentId: scoped ? "main" : undefined,
          configuredAgentsOnly: true,
          includeGlobal: true,
          includeUnknown: true,
          rowMode: "sidebar",
          limit: 200,
          archived: "all",
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
      writeMain(sessionKey, { sessionId: `transcript-${index}`, updatedAt: index + 1 });
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      const page = await listRows(projection, { agentId: "main", search: key, limit: 5 });
      expect(rowKeys(page)).not.toContain(key);
      const exact = await listRows(projection, { agentId: "main", limit: 1 }, key);
      expect(exact.sessions).toMatchObject([{ key, sessionId: "transcript-0" }]);
      writeMain(key, { sessionId: "transcript-0", updatedAt: 8, archivedAt: 8 });
      const hidden = await listRows(projection, { agentId: "main", limit: 1 }, key);
      expect(hidden.sessions).toEqual([]);
    } finally {
      projection.dispose();
    }
  });
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
      if (!query?.sessionIdOrKey) {
        return rows;
      }
      const keys = new Set(
        rows
          .filter(
            (row) =>
              row.key === query.sessionIdOrKey || row.entry.sessionId === query.sessionIdOrKey,
          )
          .map((row) => row.key),
      );
      return rows.filter((row) => keys.has(row.key));
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
