import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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

function row(index: number, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: `agent:worker:subagent:${index}`,
    sessionId: `child-session-${index}`,
    kind: "direct",
    updatedAt: index,
    spawnedBy: "agent:main:parent",
    swarmGroupId: "swarm:agent:main:parent:run-1",
    ...fields,
  };
}

const childRows = (count: number) => Array.from({ length: count }, (_, index) => row(index));
const summary = (parent: GatewaySessionRow): GatewaySessionRow => ({
  ...parent,
  swarm: parent.swarm && {
    ...parent.swarm,
    groups: parent.swarm.groups.map(({ children: _children, ...group }) => group),
  },
});
const namedParent = (rows: GatewaySessionRow[]) => ({
  ...parentRow(),
  childSessions: rows.map((child) => child.key),
});

function sessionSource(
  list: SessionCapability["list"],
  primaryRows: () => GatewaySessionRow[] = () => [],
  readDescriptor?: () => Promise<{ session: GatewaySessionRow }>,
) {
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "sessions.describe" && readDescriptor) {
      return readDescriptor();
    }
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
    emitChanged(payload: Record<string, unknown>) {
      emitEvent({ type: "event", event: "sessions.changed", payload });
    },
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

type HydrationParams = Parameters<SwarmRosterHydrator["update"]>[0];

function hydrationParams(
  sessions: HydrationParams["sessions"],
  readParent: HydrationParams["readParent"] = async () => parentRow(),
  overrides: Partial<HydrationParams> = {},
): HydrationParams {
  return {
    sessions,
    readParent,
    parentKey: parentRow().key,
    sourceEpoch: 1,
    currentRows: () => [],
    ...overrides,
  };
}

async function bootHydrator(
  parent: GatewaySessionRow,
  childPage: Promise<SessionsListResult>,
  currentRows: HydrationParams["currentRows"],
  refreshedParent = parent,
) {
  const described = vi
    .fn(async () => ({ session: refreshedParent }))
    .mockResolvedValueOnce({ session: parent });
  const sessions = sessionSource(() => childPage, undefined, described);
  await sessions.describe({ key: parent.key });
  const hydrator = createHydrator();
  hydrator.update(
    hydrationParams(
      sessions,
      (refresh) =>
        sessions.describe({ key: parent.key }, { refresh }).then(({ session }) => session ?? null),
      { parentKey: parent.key, currentRows },
    ),
  );
  await vi.advanceTimersByTimeAsync(250);
  return { hydrator, described };
}

const hydrators: SwarmRosterHydrator[] = [];
function createHydrator(params?: HydrationParams) {
  const hydrator = new SwarmRosterHydrator();
  hydrators.push(hydrator);
  if (params) {
    hydrator.update(params);
  }
  return hydrator;
}

afterEach(() => {
  for (const hydrator of hydrators.splice(0)) {
    hydrator.dispose();
  }
  vi.useRealTimers();
});

describe("isSwarmEnabledInConfig", () => {
  it("accepts both the boolean and object configuration forms", () => {
    const cases: [unknown, string | undefined, boolean][] = [
      [undefined, "worker", true],
      [{ tools: { swarm: true } }, undefined, true],
      [{ tools: { swarm: { enabled: true } } }, undefined, true],
      [{ tools: { swarm: false } }, undefined, false],
      [{ tools: { swarm: { enabled: false } } }, undefined, false],
      [
        { tools: { swarm: false }, agents: { entries: { WORKER: { tools: { swarm: true } } } } },
        "worker",
        true,
      ],
      [
        { tools: { swarm: true }, agents: { entries: { worker: { tools: { swarm: false } } } } },
        "worker",
        false,
      ],
      [
        {
          tools: { swarm: false },
          agents: { entries: [{ id: "worker", tools: { swarm: true } }] },
        },
        "worker",
        false,
      ],
    ];
    for (const [config, agentId, enabled] of cases) {
      expect(isSwarmEnabledInConfig(config, agentId)).toBe(enabled);
    }
  });
});

describe("SwarmRosterHydrator", () => {
  beforeEach(() => vi.useFakeTimers());
  it("does not re-describe collectors when their child providers finish", async () => {
    const children = Array.from({ length: 16 }, (_, index) => row(index, { status: "running" }));
    // Provider completion does not settle the collector's recorded result.
    const parent = swarmParent(children);
    const described = vi.fn(async () => ({ session: parent }));
    const sessions = sessionSource(
      async () => result(children, 0, children.length),
      () => [parent],
      described,
    );
    const hydrator = createHydrator(
      hydrationParams(sessions, (refresh) =>
        sessions.describe({ key: parent.key }, { refresh }).then((response) => response.session!),
      ),
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(described).toHaveBeenCalledTimes(1);
    for (let index = 0; index < children.length; index++) {
      children[index] = { ...children[index]!, status: "done", updatedAt: 100 + index };
      sessions.emitChanged({
        agentId: "worker",
        reason: "lifecycle",
        session: children[index],
        ancestorSessions: [{ ...summary(parent), snapshotAt: 100 + index }],
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(hydrator.rows.filter((entry) => entry.status === "done")).toHaveLength(16);
    expect(hydrator.rows.find((entry) => entry.key === parent.key)?.swarm).toEqual(parent.swarm);
    expect(described).toHaveBeenCalledTimes(1);
  });

  it.each(["older group", "bounded members", "new member", "warm new member"] as const)(
    "reconciles the initial %s child roster with the shared boot descriptor",
    async (window) => {
      const grows = window === "new member" || window === "warm new member";
      const children =
        window === "older group"
          ? [row(0), { ...row(1), swarmGroupId: "older-terminal-group", status: "done" as const }]
          : childRows(grows ? 66 : 65);
      const parent = swarmParent(children.slice(0, window === "older group" ? 1 : 64));
      if (window !== "older group") {
        parent.swarm!.groups[0]!.running = 65;
      }
      const childPage = createDeferred<SessionsListResult>();
      // Resource discovery precedes the delayed Swarm roster on chat boot.
      const { hydrator, described } = await bootHydrator(parent, childPage.promise, () =>
        window === "warm new member" ? children : [],
      );
      if (grows) {
        described.mockResolvedValue({
          session: {
            ...parent,
            swarm: {
              ...parent.swarm!,
              groups: [{ ...parent.swarm!.groups[0]!, running: 66 }],
            },
          },
        });
      }
      childPage.resolve(result(children, 0, children.length));
      await vi.advanceTimersByTimeAsync(0);
      expect(hydrator.hydrated).toBe(true);
      expect(hydrator.rows).toHaveLength(children.length + 1);
      expect(described).toHaveBeenCalledTimes(grows ? 2 : 1);
      if (grows) {
        expect(
          hydrator.rows.find((entry) => entry.key === parent.key)?.swarm?.groups[0]?.running,
        ).toBe(66);
      }
    },
  );

  it.each([
    { state: "running", shown: 1, omitted: 0, discovered: 1, reads: 2 },
    { state: "queued", shown: 1, omitted: 0, discovered: 1, reads: 2 },
    { state: "running", shown: 4, omitted: 1, discovered: 1, reads: 1 },
    { state: "queued", shown: 4, omitted: 1, discovered: 1, reads: 1 },
    { state: "running", shown: 4, omitted: 1, discovered: 2, reads: 2 },
  ] as const)(
    "reconciles $discovered unlisted $state groups against $omitted declared omitted groups",
    async ({ state, shown, omitted, discovered, reads }) => {
      const children = Array.from({ length: shown + discovered }, (_, index) => ({
        ...row(index),
        swarmGroupId: `group-${index}`,
        status: state,
      }));
      const groups = children.map((child, index) => ({
        groupId: child.swarmGroupId,
        createdAt: index < shown + omitted ? shown - index : index + 1,
        queued: state === "queued" ? 1 : 0,
        running: state === "running" ? 1 : 0,
        done: 0,
        failed: 0,
        children: [{ sessionKey: child.key, status: state }],
      }));
      const parent: GatewaySessionRow = {
        ...parentRow(),
        swarm: { groups: groups.slice(0, shown), otherActiveGroups: omitted },
      };
      const current: GatewaySessionRow = {
        ...parent,
        swarm: {
          groups: groups.toSorted((left, right) => right.createdAt - left.createdAt).slice(0, 4),
          otherActiveGroups: Math.max(0, groups.length - 4),
        },
      };
      const childPage = createDeferred<SessionsListResult>();
      // Warm child presentation does not certify the fresh descriptor's counts.
      const { hydrator, described } = await bootHydrator(
        parent,
        childPage.promise,
        () => children,
        current,
      );
      childPage.resolve(result(children, 0, children.length));
      await vi.advanceTimersByTimeAsync(0);
      expect(described).toHaveBeenCalledTimes(reads);
      expect(hydrator.rows.find((entry) => entry.key === parent.key)?.swarm).toEqual(
        reads === 2 ? current.swarm : parent.swarm,
      );
    },
  );

  it("keeps child requests and parent reads independent of unrelated canonical roster publications", async () => {
    let children = [row(0)];
    const detailedParent = () => swarmParent(children);
    const list = vi.fn(async () => result(children, 0, children.length));
    const readParent = vi.fn(async () => detailedParent());
    const sessions = sessionSource(list, () => [summary(detailedParent())]);
    const params = hydrationParams(sessions, readParent);
    const hydrator = createHydrator(params);
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
  });

  it.each(["canonical", "filtered"] as const)(
    "revalidates a changed %s parent summary received during the initial describe",
    async (source) => {
      const stale = createDeferred<GatewaySessionRow>();
      const initial = { ...swarmParent([row(0)]), updatedAt: 1 };
      const current = { ...swarmParent([row(0), row(1)]), updatedAt: 2 };
      const currentSummary = summary(current);
      const readParent = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(current);
      const sessions = sessionSource(
        vi.fn(async () => result([], 0, 0)),
        () => [currentSummary],
      );
      const hydrator = createHydrator(hydrationParams(sessions, readParent));
      await vi.advanceTimersByTimeAsync(250);
      expect(readParent).toHaveBeenCalledTimes(1);
      if (source === "canonical") {
        await sessions.refresh({ agentId: "main", force: true });
      } else {
        await sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
      }
      expect(hydrator.rows).toEqual([currentSummary]);
      stale.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      expect(readParent).toHaveBeenCalledTimes(2);
      expect(hydrator.rows).toEqual([current]);
    },
  );

  it("queues fresh parent membership when a child-only change overlaps an older describe", async () => {
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
    const hydrator = createHydrator(hydrationParams(sessions, readParent));
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
  });

  it("rechecks parent membership when the first child page disagrees with an earlier describe", async () => {
    const firstPage = createDeferred<SessionsListResult>();
    const initial = swarmParent([row(0)]);
    const current = swarmParent([row(1)]);
    const readParent = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(current);
    const sessions = sessionSource(vi.fn(() => firstPage.promise));
    const hydrator = createHydrator(hydrationParams(sessions, readParent));
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([initial]);
    firstPage.resolve(result([row(1)], 0, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(readParent).toHaveBeenCalledTimes(2);
    expect(hydrator.rows).toEqual([expect.objectContaining({ key: row(1).key }), current]);
  });

  it.each([0, 1, 2])(
    "keeps the roster incomplete when a new child is named during a read holding %i children",
    async (count) => {
      let children = childRows(count);
      let held = createDeferred();
      held.resolve();
      const list = vi.fn(async () => {
        const answer = result(children, 0, children.length);
        await held.promise;
        return answer;
      });
      const sessions = sessionSource(list);
      const hydrator = createHydrator();
      const hydration: boolean[] = [];
      const stop = hydrator.subscribe(() =>
        hydration.push(hydrator.hydrated && !hydrator.pendingChildRead),
      );
      onTestFinished(stop);

      hydrator.update(hydrationParams(sessions, async () => namedParent(children)));
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
    },
  );

  it("keeps a newer read's retry when older pagination finishes after that read fails", async () => {
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
    const hydrator = createHydrator(hydrationParams(sessions, async () => namedParent(children)));
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
  });

  it("asks once for a named child the list never returns and stays hydrated afterwards", async () => {
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
    const hydrator = createHydrator(hydrationParams(sessions, readParent));
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
  });

  it("keeps a freshly fetched tie winner over an unchanged current page", async () => {
    const running = { ...row(0), status: "running" as const, updatedAt: 5 };
    const done = { ...row(0), status: "done" as const, updatedAt: 5 };
    let currentRows: GatewaySessionRow[] = [running];
    const hydrator = createHydrator();
    const sessions = sessionSource(vi.fn(async () => result([done], 0, 1)));

    const expectChildren = (status: string) =>
      expect(hydrator.rows.filter((entry) => entry.key !== parentRow().key)).toEqual([
        expect.objectContaining({ status }),
      ]);
    const params = hydrationParams(sessions, undefined, { currentRows: () => currentRows });
    hydrator.update(params);
    await vi.runAllTimersAsync();

    expectChildren("done");
    hydrator.update(params);
    expectChildren("done");
    currentRows = [{ ...running, status: "failed" }];
    sessions.publishRow(currentRows[0]!);
    hydrator.update(params);
    await vi.advanceTimersByTimeAsync(0);
    expectChildren("failed");
  });

  it("backs off parent failures without reloading healthy child rows", async () => {
    const list = vi.fn(async () => result([row(0)], 0, 1));
    const readParent = vi
      .fn()
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockRejectedValueOnce(new Error("parent unavailable"))
      .mockResolvedValue(parentRow());
    const hydrator = createHydrator(hydrationParams(sessionSource(list), readParent));
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
  });
  it("fences an old global owner read and clears a denied parent without restoring stale page totals", async () => {
    const oldRead = createDeferred<GatewaySessionRow>();
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
    const hydrator = createHydrator();
    const params = {
      sessions,
      parentKey: "global",
      sourceEpoch: 1,
      currentRows: () => [main],
    };
    hydrator.update({ ...params, agentId: "main", readParent: () => oldRead.promise });
    await vi.advanceTimersByTimeAsync(250);
    hydrator.update({ ...params, agentId: "other", readParent: async () => other });
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([other]);
    oldRead.resolve(main);
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows).toEqual([other]);
    const denied = { ...params, agentId: "other", readParent: async () => null };
    hydrator.update(denied);
    sessions.invalidateParent("global", "other");
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([]);
    hydrator.update(denied);
    expect(hydrator.rows).toEqual([]);
  });
  it("publishes parent counts before slow optional children and retains them when that read fails", async () => {
    const childRead = createDeferred<SessionsListResult>();
    const parent: GatewaySessionRow = {
      ...parentRow(),
      swarm: {
        groups: [{ groupId: "group", createdAt: 1, queued: 0, running: 0, done: 25, failed: 5 }],
        otherActiveGroups: 0,
      },
    };
    const sessions = sessionSource(vi.fn(() => childRead.promise));
    const hydrator = createHydrator(hydrationParams(sessions, async () => parent));
    await vi.advanceTimersByTimeAsync(250);
    expect(hydrator.rows).toEqual([parent]);
    childRead.reject(new Error("Child details temporarily unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(hydrator.rows).toEqual([parent]);
  });
  it.each(["missing", "denied"] as const)(
    "does not restore a %s parent when an earlier child read finishes late",
    async (outcome) => {
      const children = createDeferred<SessionsListResult>();
      const parent: GatewaySessionRow = {
        ...parentRow(),
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
      const hydrator = createHydrator();
      const stop = hydrator.subscribe(() => onRows(hydrator.rows));
      onTestFinished(stop);
      let currentRows = [parent];
      const params = {
        sessions,
        parentKey: parent.key,
        sourceEpoch: 1,
        currentRows: () => currentRows,
      };

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
    },
  );
});

describe("hydrateSwarmSessionRows", () => {
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
});
