import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { childSessionListQuery } from "./child-session-data.ts";
import type { SessionCapability, SessionListOptions } from "./index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";
import {
  hydrateSwarmSessionRows,
  isSwarmEnabledInConfig,
  mergeSwarmSessionRows,
  SwarmRosterHydrator,
} from "./swarm-roster.ts";

function row(index: number): GatewaySessionRow {
  return {
    key: `agent:worker:subagent:${index}`,
    sessionId: `child-session-${index}`,
    kind: "direct",
    updatedAt: index,
    spawnedBy: "agent:main:parent",
    swarmGroupId: "swarm:agent:main:parent:run-1",
  };
}

function sessionSource(
  list: SessionCapability["list"],
  primaryRows: () => GatewaySessionRow[] = () => [],
) {
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "sessions.list") {
      const rows = primaryRows();
      return isRecord(params) && params.spawnedBy ? list(params) : result(rows, 0, rows.length);
    }
    return { subscribed: true };
  });
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  onTestFinished(() => sessions.dispose());
  return Object.assign(sessions, {
    publishRow(entry: GatewaySessionRow) {
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { key: entry.key, session: entry, reason: "patch" },
      });
    },
    invalidateParent(key = "agent:main:parent", agentId = "main") {
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { key, agentId, reason: "patch" },
      });
    },
  });
}

function parentRow(): GatewaySessionRow {
  return { key: "agent:main:parent", sessionId: "parent-session", kind: "direct" };
}

function swarmParent(children: GatewaySessionRow[]): GatewaySessionRow {
  return {
    ...parentRow(),
    swarm: {
      groups: [
        {
          groupId: row(0).swarmGroupId!,
          createdAt: 1,
          queued: 0,
          running: children.filter((child) => child.status !== "done").length,
          done: children.filter((child) => child.status === "done").length,
          failed: 0,
          children: children.map((child) => ({
            sessionKey: child.key,
            status: child.status === "done" ? "done" : "running",
          })),
        },
      ],
      otherActiveGroups: 0,
    },
  };
}

function result(rows: GatewaySessionRow[], offset: number, totalCount: number): SessionsListResult {
  const nextOffset = offset + rows.length;
  return {
    ts: Date.now(),
    path: "state/openclaw.sqlite",
    count: rows.length,
    totalCount,
    limitApplied: 10_000,
    offset,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
    hasMore: nextOffset < totalCount,
    defaults: {} as SessionsListResult["defaults"],
    sessions: rows,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isSwarmEnabledInConfig", () => {
  it.each([
    { label: "unloaded config", config: undefined },
    { label: "omitted tools", config: {} },
    { label: "limits-only swarm", config: { tools: { swarm: { maxConcurrent: 3 } } } },
    {
      label: "limits-only agent swarm",
      config: { agents: { entries: { worker: { tools: { swarm: { maxConcurrent: 3 } } } } } },
    },
  ])("defaults to enabled with $label", ({ config }) => {
    expect(isSwarmEnabledInConfig(config, "worker")).toBe(true);
  });

  it.each([
    { globalSwarm: false, agentSwarm: {}, expected: false },
    { globalSwarm: { enabled: false }, agentSwarm: { maxConcurrent: 3 }, expected: false },
    { globalSwarm: true, agentSwarm: { enabled: false }, expected: false },
    { globalSwarm: { enabled: true }, agentSwarm: false, expected: false },
    { globalSwarm: false, agentSwarm: { enabled: true }, expected: true },
    { globalSwarm: { enabled: false }, agentSwarm: true, expected: true },
  ])("resolves global $globalSwarm and agent $agentSwarm as $expected", (testCase) => {
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: testCase.globalSwarm },
          agents: { entries: { WORKER: { tools: { swarm: testCase.agentSwarm } } } },
        },
        "worker",
      ),
    ).toBe(testCase.expected);
  });

  it("accepts both the boolean and object configuration forms", () => {
    expect(isSwarmEnabledInConfig({ tools: { swarm: true } })).toBe(true);
    expect(isSwarmEnabledInConfig({ tools: { swarm: { enabled: true } } })).toBe(true);
    expect(isSwarmEnabledInConfig({ tools: { swarm: false } })).toBe(false);
    expect(isSwarmEnabledInConfig({ tools: { swarm: { enabled: false } } })).toBe(false);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: false },
          agents: { entries: { WORKER: { tools: { swarm: true } } } },
        },
        "worker",
      ),
    ).toBe(true);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: true },
          agents: { entries: { worker: { tools: { swarm: false } } } },
        },
        "worker",
      ),
    ).toBe(false);
    expect(
      isSwarmEnabledInConfig(
        {
          tools: { swarm: false },
          agents: { entries: [{ id: "worker", tools: { swarm: true } }] },
        },
        "worker",
      ),
    ).toBe(false);
  });
});

describe("SwarmRosterHydrator", () => {
  it("keeps child requests and parent reads independent of unrelated canonical roster publications", async () => {
    vi.useFakeTimers();
    let children = [row(0)];
    const detailedParent = () => swarmParent(children);
    const list = vi.fn(async () => result(children, 0, children.length));
    const readParent = vi.fn(async () => detailedParent());
    const sessions = sessionSource(list, () => {
      const parent = detailedParent();
      return [
        {
          ...parent,
          swarm: {
            ...parent.swarm!,
            groups: parent.swarm!.groups.map(({ children: _children, ...group }) => group),
          },
        },
      ];
    });
    const hydrator = new SwarmRosterHydrator();
    const params = {
      sessions,
      readParent,
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [],
      onRows: () => undefined,
    };
    try {
      hydrator.update(params);
      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.rows.map((entry) => entry.key)).toEqual([row(0).key, parentRow().key]);
      for (let publication = 0; publication < 10; publication++) {
        await sessions.refresh({ agentId: "main", force: true });
        hydrator.update(params);
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(list).toHaveBeenCalledTimes(1);
      expect(readParent).toHaveBeenCalledTimes(1);
      expect(hydrator.rows.find((entry) => entry.key === parentRow().key)?.swarm).toEqual(
        detailedParent().swarm,
      );

      children = [{ ...row(1), label: "New child", status: "done" }];
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(list).toHaveBeenCalledTimes(2);
      expect(readParent).toHaveBeenCalledTimes(2);
      expect(hydrator.rows).toEqual([
        expect.objectContaining({ key: row(1).key, label: "New child", status: "done" }),
        detailedParent(),
      ]);
    } finally {
      hydrator.dispose();
    }
  });

  it.each(["canonical", "filtered"] as const)(
    "revalidates a changed %s parent summary received during the initial describe",
    async (source) => {
      vi.useFakeTimers();
      const stale = createDeferred<GatewaySessionRow>();
      const initial = { ...swarmParent([row(0)]), updatedAt: 1 };
      const current = { ...swarmParent([row(0), row(1)]), updatedAt: 2 };
      const summary = {
        ...current,
        swarm: {
          ...current.swarm!,
          groups: current.swarm!.groups.map(({ children: _children, ...group }) => group),
        },
      };
      const readParent = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(current);
      const sessions = sessionSource(
        vi.fn(async () => result([], 0, 0)),
        () => [summary],
      );
      const hydrator = new SwarmRosterHydrator();
      try {
        hydrator.update({
          sessions,
          readParent,
          parentKey: initial.key,
          sourceEpoch: 1,
          currentRows: () => [],
          onRows: () => undefined,
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(readParent).toHaveBeenCalledTimes(1);
        if (source === "canonical") {
          await sessions.refresh({ agentId: "main", force: true });
        } else {
          await sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
        }
        expect(hydrator.rows).toEqual([summary]);
        stale.resolve(initial);
        await vi.advanceTimersByTimeAsync(0);
        expect(readParent).toHaveBeenCalledTimes(2);
        expect(hydrator.rows).toEqual([current]);
      } finally {
        hydrator.dispose();
      }
    },
  );

  it("coalesces a changed parent summary and its event invalidation into one describe", async () => {
    vi.useFakeTimers();
    let parent = swarmParent([row(0)]);
    const readParent = vi.fn(async () => parent);
    const sessions = sessionSource(vi.fn(async () => result([], 0, 0)));
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent,
        parentKey: parent.key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(readParent).toHaveBeenCalledTimes(1);
      parent = swarmParent([row(0), row(1)]);
      sessions.publishRow({
        ...parent,
        swarm: {
          ...parent.swarm!,
          groups: parent.swarm!.groups.map(({ children: _children, ...group }) => group),
        },
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(readParent).toHaveBeenCalledTimes(2);
      expect(hydrator.rows.find((entry) => entry.key === parent.key)?.swarm).toEqual(parent.swarm);
    } finally {
      hydrator.dispose();
    }
  });

  it("rechecks a parent after an invalidated denial without clearing newer intent", async () => {
    vi.useFakeTimers();
    const stale = createDeferred<GatewaySessionRow>();
    const initial = swarmParent([row(0)]);
    const current = swarmParent([row(1)]);
    const readParent = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(current);
    const sessions = sessionSource(vi.fn(async () => result([], 0, 0)));
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent,
        parentKey: initial.key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(0);
      expect(readParent).toHaveBeenCalledTimes(2);
      sessions.invalidateParent();
      stale.reject(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Old parent read denied" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(readParent).toHaveBeenCalledTimes(3);
      expect(hydrator.rows).toEqual([current]);
    } finally {
      hydrator.dispose();
    }
  });

  it("queues fresh parent membership when a child-only change overlaps an older describe", async () => {
    vi.useFakeTimers();
    const stale = createDeferred<GatewaySessionRow>();
    let children = [row(0)];
    const initial = swarmParent(children);
    const current = swarmParent([row(1)]);
    const readParent = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(current);
    const sessions = sessionSource(vi.fn(async () => result(children, 0, children.length)));
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent,
        parentKey: initial.key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(0);
      expect(readParent).toHaveBeenCalledTimes(2);
      children = [row(1)];
      sessions.publishRow(children[0]!);
      await vi.advanceTimersByTimeAsync(5_000);
      stale.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      expect(readParent).toHaveBeenCalledTimes(3);
      expect(hydrator.rows).toEqual([expect.objectContaining({ key: row(1).key }), current]);
    } finally {
      hydrator.dispose();
    }
  });

  it("rechecks parent membership when the first child page disagrees with an earlier describe", async () => {
    vi.useFakeTimers();
    const firstPage = createDeferred<SessionsListResult>();
    const initial = swarmParent([row(0)]);
    const current = swarmParent([row(1)]);
    const readParent = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(current);
    const sessions = sessionSource(vi.fn(() => firstPage.promise));
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent,
        parentKey: initial.key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.rows).toEqual([initial]);
      firstPage.resolve(result([row(1)], 0, 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(readParent).toHaveBeenCalledTimes(2);
      expect(hydrator.rows).toEqual([expect.objectContaining({ key: row(1).key }), current]);
    } finally {
      hydrator.dispose();
    }
  });

  it("clears rows when the gateway source epoch changes", () => {
    vi.useFakeTimers();
    const onRows = vi.fn();
    const hydrator = new SwarmRosterHydrator();
    const sessions = sessionSource(vi.fn(async () => result([row(0)], 0, 1)));

    hydrator.update({
      sessions,
      readParent: async () => parentRow(),
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [row(0)],
      onRows,
    });
    expect(hydrator.rows).toHaveLength(1);

    hydrator.update({
      sessions,
      readParent: async () => parentRow(),
      parentKey: "agent:main:parent",
      sourceEpoch: 2,
      currentRows: () => [],
      onRows,
    });

    expect(hydrator.rows).toEqual([]);
    expect(onRows).toHaveBeenLastCalledWith([]);
    hydrator.dispose();
  });

  it("reports hydration only after its own child query fills the roster", async () => {
    vi.useFakeTimers();
    const onRows = vi.fn();
    const hydrator = new SwarmRosterHydrator();
    const params = {
      sessions: sessionSource(vi.fn(async () => result([row(0), row(1)], 0, 2))),
      readParent: async () => parentRow(),
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      // Another list happened to hold one of the two children.
      currentRows: () => [row(0)],
      onRows,
    };
    try {
      hydrator.update(params);
      expect(hydrator.rows.map((entry) => entry.key)).toEqual([row(0).key]);
      expect(hydrator.hydrated).toBe(false);
      expect(hydrator.childrenRead).toBe(false);

      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.hydrated).toBe(true);
      expect(hydrator.childrenRead).toBe(true);
      expect(hydrator.rows.map((entry) => entry.key).toSorted()).toEqual(
        [row(0).key, row(1).key, parentRow().key].toSorted(),
      );
      // The page is told, so a label waiting on the roster cannot stay behind.
      expect(onRows).toHaveBeenLastCalledWith(hydrator.rows);

      hydrator.update({ ...params, sourceEpoch: 2, currentRows: () => [] });
      expect(hydrator.hydrated).toBe(false);
      expect(hydrator.childrenRead).toBe(false);
    } finally {
      hydrator.dispose();
    }
  });

  it("reads the child list at once when the parent names a child it does not hold", async () => {
    vi.useFakeTimers();
    let children = [row(0)];
    const list = vi.fn(async () => result(children, 0, children.length));
    const named = (rows: GatewaySessionRow[]): GatewaySessionRow => ({
      ...parentRow(),
      childSessions: rows.map((entry) => entry.key),
    });
    const readParent = vi.fn(async () => named(children));
    const sessions = sessionSource(list);
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent,
        parentKey: parentRow().key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.hydrated).toBe(true);
      const reads = list.mock.calls.length;

      // A launch reaches the parent row first; the child query re-reads on a slower pace.
      children = [row(0), row(1)];
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(0);
      expect(list.mock.calls.length).toBe(reads + 1);
      expect(hydrator.hydrated).toBe(true);
      expect(hydrator.rows.map((entry) => entry.key)).toContain(row(1).key);

      // The same answer does not ask again.
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(0);
      expect(list.mock.calls.length).toBe(reads + 1);
    } finally {
      hydrator.dispose();
    }
  });

  it.each([0, 1, 2])(
    "keeps the roster incomplete when a new child is named during a read holding %i children",
    async (count) => {
      vi.useFakeTimers();
      let children = Array.from({ length: count }, (_, index) => row(index));
      let held = createDeferred();
      held.resolve();
      const list = vi.fn(async () => {
        const answer = result(children, 0, children.length);
        await held.promise;
        return answer;
      });
      const sessions = sessionSource(list);
      const hydrator = new SwarmRosterHydrator();
      const hydration: boolean[] = [];
      try {
        hydrator.update({
          sessions,
          readParent: async () => ({
            ...parentRow(),
            childSessions: children.map((child) => child.key),
          }),
          parentKey: parentRow().key,
          sourceEpoch: 1,
          currentRows: () => [],
          onRows: () => hydration.push(hydrator.hydrated && !hydrator.pendingChildRead),
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(hydrator.hydrated).toBe(true);

        const previousRead = createDeferred();
        held = previousRead;
        const refresh = sessions.refreshList({
          ...childSessionListQuery(parentRow().key, 10_000),
          force: true,
        });
        await vi.advanceTimersByTimeAsync(0);
        const reads = list.mock.calls.length;

        children = [...children, row(count)];
        held = createDeferred();
        sessions.invalidateParent();
        await vi.advanceTimersByTimeAsync(0);
        expect(hydrator.hydrated).toBe(false);
        expect(list).toHaveBeenCalledTimes(reads);

        hydration.length = 0;
        previousRead.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(list).toHaveBeenCalledTimes(reads + 1);
        expect(hydrator.hydrated).toBe(true);
        expect(hydrator.pendingChildRead).toBe(true);
        expect(hydration.length).toBeGreaterThan(0);
        expect(hydration.every((loaded) => !loaded)).toBe(true);
        expect(hydrator.childrenRead).toBe(true);

        held.resolve();
        await refresh;
        await vi.advanceTimersByTimeAsync(0);
        expect(hydrator.hydrated).toBe(true);
        expect(hydrator.pendingChildRead).toBe(false);
        expect(hydrator.rows.map((child) => child.key)).toContain(row(count).key);
      } finally {
        hydrator.dispose();
      }
    },
  );

  it("keeps a newer read's retry when older pagination finishes after that read fails", async () => {
    vi.useFakeTimers();
    const firstPage = createDeferred<SessionsListResult>();
    const lastPage = createDeferred<SessionsListResult>();
    let children = [row(0), row(1)];
    let firstPageReads = 0;
    const list = vi.fn(async (options: SessionListOptions = {}) => {
      if (options.offset === 1) {
        return lastPage.promise;
      }
      firstPageReads += 1;
      if (firstPageReads === 2) {
        return firstPage.promise;
      }
      if (firstPageReads === 3) {
        throw new Error("Child list temporarily unavailable");
      }
      return result(children, 0, children.length);
    });
    const sessions = sessionSource(list);
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent: async () => ({
          ...parentRow(),
          childSessions: children.map((child) => child.key),
        }),
        parentKey: parentRow().key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.hydrated).toBe(true);

      const refresh = sessions.refreshList({
        ...childSessionListQuery(parentRow().key, 10_000),
        force: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      children = [...children, row(2)];
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(0);
      firstPage.resolve(result([row(0)], 0, 2));
      await refresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(firstPageReads).toBe(3);

      lastPage.resolve(result([row(1)], 1, 2));
      await vi.advanceTimersByTimeAsync(0);
      expect(hydrator.pendingChildRead).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(firstPageReads).toBe(4);
      expect(hydrator.hydrated).toBe(true);
      expect(hydrator.rows.map((child) => child.key)).toContain(row(2).key);
    } finally {
      hydrator.dispose();
    }
  });

  it("asks once for a named child the list never returns and stays hydrated afterwards", async () => {
    vi.useFakeTimers();
    // The parent keeps naming an archived child; the default list leaves it out.
    const archived = "agent:worker:subagent:archived";
    let children = [row(0)];
    let held = createDeferred();
    held.resolve();
    const list = vi.fn(async () => {
      const answer = result(children, 0, children.length);
      await held.promise;
      return answer;
    });
    const readParent = vi.fn(async () => ({
      ...parentRow(),
      childSessions: [...children.map((entry) => entry.key), archived],
    }));
    const sessions = sessionSource(list);
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions,
        readParent,
        parentKey: parentRow().key,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.hydrated).toBe(true);
      const reads = list.mock.calls.length;
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(250);
      expect(list.mock.calls.length).toBe(reads);

      // A launch asks for the new child alone: one read, and no count until it answers.
      children = [row(0), row(1)];
      held = createDeferred();
      sessions.invalidateParent();
      await vi.advanceTimersByTimeAsync(0);
      expect(list.mock.calls.length).toBe(reads + 1);
      expect(hydrator.hydrated).toBe(false);
      // Rows already shown stay trusted while the launch re-read is pending.
      expect(hydrator.childrenRead).toBe(true);
      held.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(hydrator.hydrated).toBe(true);
      expect(list.mock.calls.length).toBe(reads + 1);
    } finally {
      hydrator.dispose();
    }
  });

  it("keeps a freshly fetched tie winner over an unchanged current page", async () => {
    vi.useFakeTimers();
    const running = { ...row(0), status: "running" as const, updatedAt: 5 };
    const done = { ...row(0), status: "done" as const, updatedAt: 5 };
    let currentRows: GatewaySessionRow[] = [running];
    const hydrator = new SwarmRosterHydrator();
    const sessions = sessionSource(vi.fn(async () => result([done], 0, 1)));

    const params = {
      sessions,
      readParent: async () => parentRow(),
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => currentRows,
      onRows: () => undefined,
    };
    hydrator.update(params);
    await vi.runAllTimersAsync();

    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
    hydrator.update(params);
    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
    currentRows = [{ ...running, status: "failed" }];
    sessions.publishRow(currentRows[0]!);
    hydrator.update(params);
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ status: "failed" }),
    ]);
    hydrator.dispose();
  });

  it("keeps retrying at a bounded cadence after three transient failures", async () => {
    vi.useFakeTimers();
    const onRows = vi.fn();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(result([row(0)], 0, 1));
    const hydrator = new SwarmRosterHydrator();
    const sessions = sessionSource(list);
    const readParent = vi.fn(async () => swarmParent([row(0)]));

    hydrator.update({
      sessions,
      readParent,
      parentKey: "agent:main:parent",
      sourceEpoch: 1,
      currentRows: () => [],
      onRows,
    });
    await vi.runAllTimersAsync();

    expect(list).toHaveBeenCalledTimes(4);
    expect(readParent).toHaveBeenCalledTimes(1);
    expect(hydrator.rows.filter((entry) => entry.key !== "agent:main:parent")).toEqual([
      expect.objectContaining({ key: row(0).key }),
    ]);
    hydrator.dispose();
  });

  it("backs off parent failures without reloading healthy child rows", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => result([row(0)], 0, 1));
    const readParent = vi
      .fn()
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockResolvedValue(parentRow());
    const hydrator = new SwarmRosterHydrator();
    try {
      hydrator.update({
        sessions: sessionSource(list),
        parentKey: "agent:main:parent",
        readParent,
        sourceEpoch: 1,
        currentRows: () => [],
        onRows: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(readParent).toHaveBeenCalledTimes(1);
      for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(readParent).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(readParent).toHaveBeenCalledTimes(index + 2);
        expect(list).toHaveBeenCalledTimes(1);
      }
      expect(hydrator.rows.map((entry) => entry.key)).toEqual([row(0).key, parentRow().key]);
    } finally {
      hydrator.dispose();
    }
  });
  it("fences an old global owner read and clears a denied parent without restoring stale page totals", async () => {
    vi.useFakeTimers();
    let release!: (row: GatewaySessionRow) => void;
    const oldRead = new Promise<GatewaySessionRow>((resolve) => {
      release = resolve;
    });
    const main: GatewaySessionRow = {
      key: "global",
      kind: "global",
      agentId: "main",
      sessionId: "main-global-session",
      label: "Old owner",
    };
    const other: GatewaySessionRow = {
      key: "global",
      kind: "global",
      agentId: "other",
      sessionId: "other-global-session",
      label: "Current owner",
    };
    const sessions = sessionSource(vi.fn(async () => result([], 0, 0)));
    const hydrator = new SwarmRosterHydrator();
    const params = {
      sessions,
      parentKey: "global",
      sourceEpoch: 1,
      currentRows: () => [main],
      onRows: () => {},
    };
    hydrator.update({ ...params, agentId: "main", readParent: () => oldRead });
    await vi.advanceTimersByTimeAsync(250);
    hydrator.update({ ...params, agentId: "other", readParent: async () => other });
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([other]);
    release(main);
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows).toEqual([other]);
    const denied = { ...params, agentId: "other", readParent: async () => null };
    hydrator.update(denied);
    sessions.invalidateParent("global", "other");
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([]);
    hydrator.update(denied);
    expect(hydrator.rows).toEqual([]);
    hydrator.dispose();
  });
  it("publishes parent counts before slow optional children and retains them when that read fails", async () => {
    vi.useFakeTimers();
    let rejectChildren!: (error: Error) => void;
    const childRead = new Promise<SessionsListResult>((_resolve, reject) => {
      rejectChildren = reject;
    });
    const parent: GatewaySessionRow = {
      key: "agent:main:parent",
      sessionId: "parent-session",
      kind: "direct",
      swarm: {
        groups: [{ groupId: "group", createdAt: 1, queued: 0, running: 0, done: 25, failed: 5 }],
        otherActiveGroups: 0,
      },
    };
    const sessions = sessionSource(vi.fn(() => childRead));
    const hydrator = new SwarmRosterHydrator();
    hydrator.update({
      sessions,
      parentKey: parent.key,
      sourceEpoch: 1,
      readParent: async () => parent,
      currentRows: () => [],
      onRows: () => {},
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([parent]);
    rejectChildren(new Error("Child details temporarily unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows).toEqual([parent]);
    hydrator.dispose();
  });
  it.each(["missing", "denied"] as const)(
    "does not restore a %s parent when an earlier child read finishes late",
    async (outcome) => {
      vi.useFakeTimers();
      const children = createDeferred<SessionsListResult>();
      const parent: GatewaySessionRow = {
        key: "agent:main:parent",
        sessionId: "parent-session",
        kind: "direct",
        swarm: {
          groups: [{ groupId: "group", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 }],
          otherActiveGroups: 0,
        },
      };
      const sessions = sessionSource(
        vi
          .fn()
          .mockReturnValueOnce(children.promise)
          .mockResolvedValue(result([], 0, 0)),
      );
      const onRows = vi.fn();
      const hydrator = new SwarmRosterHydrator();
      let currentRows = [parent];
      const params = {
        sessions,
        parentKey: parent.key,
        sourceEpoch: 1,
        currentRows: () => currentRows,
        onRows,
      };
      try {
        hydrator.update({ ...params, readParent: async () => parent });
        await vi.advanceTimersByTimeAsync(250);
        expect(hydrator.rows).toEqual([parent]);
        const deniedParams = {
          ...params,
          readParent: async () => {
            if (outcome === "denied") {
              throw new GatewayRequestError({
                code: "INVALID_REQUEST",
                message: "Parent unavailable",
              });
            }
            return null;
          },
        };
        hydrator.update(deniedParams);
        sessions.invalidateParent();
        await vi.advanceTimersByTimeAsync(250);
        expect(hydrator.rows).toEqual([]);
        currentRows = [parent, { ...row(0), label: "Changed after denial" }];
        hydrator.update(deniedParams);
        expect(hydrator.rows).toEqual([]);
        children.resolve(result([row(0)], 0, 1));
        await vi.advanceTimersByTimeAsync(0);
        expect(hydrator.rows).toEqual([]);
        expect(onRows).toHaveBeenLastCalledWith([]);
      } finally {
        hydrator.dispose();
      }
    },
  );
});

describe("hydrateSwarmSessionRows", () => {
  it("hydrates paginated cross-agent children outside the normal session page", async () => {
    const children = Array.from({ length: 10_055 }, (_, index) => row(index));
    const list = vi.fn(async (options: SessionListOptions = {}) => {
      const offset = options.offset ?? 0;
      return result(children.slice(offset, offset + 10_000), offset, children.length);
    });
    const rows = await hydrateSwarmSessionRows({
      sessions: sessionSource(list),
      parentKey: "agent:main:parent",
      isCurrent: () => true,
    });

    expect(rows).toHaveLength(10_055);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        spawnedBy: "agent:main:parent",
        limit: 10_000,
        includeGlobal: false,
        configuredAgentsOnly: true,
      }),
    );
    expect(list).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 10_000 }));
  });

  it("restarts pagination when updated rows move across offset boundaries", async () => {
    const running = { ...row(1), status: "running" as const };
    const done = { ...row(1), status: "done" as const, updatedAt: 10 };
    const pages = [
      [row(0), running],
      [running, row(2)],
      [row(3), row(0)],
      [done, row(2)],
    ];
    let callIndex = 0;
    const list = vi.fn(async (options: SessionListOptions = {}) => {
      const rows = pages[callIndex] ?? [];
      callIndex += 1;
      return result(rows, options.offset ?? 0, 4);
    });

    const rows = await hydrateSwarmSessionRows({
      sessions: sessionSource(list),
      parentKey: "agent:main:parent",
      isCurrent: () => true,
    });

    expect(rows?.map((candidate) => candidate.key).toSorted()).toEqual(
      [row(0).key, row(1).key, row(2).key, row(3).key].toSorted(),
    );
    expect(rows?.find((candidate) => candidate.key === done.key)?.status).toBe("done");
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("keeps the freshest row when hydration overlaps a current-page snapshot", () => {
    const stale = { ...row(0), status: "running" as const, updatedAt: 5, runtimeSampledAt: 10 };
    const fresh = { ...row(0), status: "done" as const, updatedAt: 6, runtimeSampledAt: 20 };

    expect(mergeSwarmSessionRows([fresh], [stale])).toEqual([fresh]);
    expect(mergeSwarmSessionRows([stale], [fresh])).toEqual([fresh]);

    const decorated = { ...stale, status: "done" as const };
    expect(mergeSwarmSessionRows([stale], [decorated])).toEqual([decorated]);

    const firstOnly = row(1);
    const parent: GatewaySessionRow = { key: "agent:main:parent", kind: "direct" };
    const changedCurrent = { ...fresh, status: "failed" as const };
    const lastOnly = row(2);
    const merged = mergeSwarmSessionRows(
      [stale, firstOnly],
      [fresh, parent],
      [changedCurrent, lastOnly],
    );
    expect(merged).toEqual([changedCurrent, firstOnly, parent, lastOnly]);
    expect(merged[0]).toBe(changedCurrent);
    expect(merged[1]).toBe(firstOnly);
    expect(merged[2]).toBe(parent);
    expect(merged[3]).toBe(lastOnly);
    expect(mergeSwarmSessionRows([], [], [fresh])).toEqual([fresh]);
  });

  it("drops stale hydration results", async () => {
    const rows = await hydrateSwarmSessionRows({
      sessions: sessionSource(vi.fn(async () => result([row(0)], 0, 1))),
      parentKey: "agent:main:parent",
      isCurrent: () => false,
    });

    expect(rows).toBeNull();
  });
});
