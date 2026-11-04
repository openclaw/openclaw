import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { childSessionListQuery } from "./child-session-data.ts";
import type { SessionCapability, SessionListOptions } from "./index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import {
  hydrateSwarmSessionRows,
  isSwarmEnabledInConfig,
  mergeSwarmSessionRows,
  SwarmRosterHydrator,
} from "./swarm-roster.ts";

type Row = GatewaySessionRow;
type Params = Parameters<SwarmRosterHydrator["update"]>[0];
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const parentRow = (fields: Partial<Row> = {}): Row => ({
  key: "agent:main:parent",
  sessionId: "parent-session",
  kind: "direct",
  ...fields,
});
const row = (index: number, fields: Partial<Row> = {}): Row => ({
  key: `agent:worker:subagent:${index}`,
  sessionId: `child-session-${index}`,
  kind: "direct",
  updatedAt: index,
  spawnedBy: parentRow().key,
  swarmGroupId: "swarm:agent:main:parent:run-1",
  ...fields,
});
const childRows = (count: number) => Array.from({ length: count }, (_, index) => row(index));
const namedParent = (children: Row[]) =>
  parentRow({ childSessions: children.map(({ key }) => key) });
const summary = (parent: Row): Row => ({
  ...parent,
  swarm: parent.swarm && {
    ...parent.swarm,
    groups: parent.swarm.groups.map(({ children: _children, ...group }) => group),
  },
});
function swarmParent(children: Row[], running?: number): Row {
  return parentRow({
    swarm: {
      otherActiveGroups: 0,
      groups: [
        {
          groupId: row(0).swarmGroupId!,
          createdAt: 1,
          queued: 0,
          failed: 0,
          running: running ?? children.filter((child) => child.status !== "done").length,
          done: children.filter((child) => child.status === "done").length,
          children: children.map((child) => ({
            sessionKey: child.key,
            status: child.status === "done" ? "done" : "running",
          })),
        },
      ],
    },
  });
}
function result(rows: Row[], offset = 0, totalCount = rows.length): SessionsListResult {
  const next = offset + rows.length;
  return {
    ...sessionsResult(rows, Date.now()),
    totalCount,
    limitApplied: 10_000,
    offset,
    nextOffset: next < totalCount ? next : null,
    hasMore: next < totalCount,
  };
}

function fixture(
  options: {
    children?: Row[];
    parent?: Row;
    seed?: Row[];
    primary?: () => Row[];
    list?: SessionCapability["list"];
    readParent?: Params["readParent"];
  } = {},
) {
  const state = {
    children: options.children ?? [],
    parent: options.parent ?? parentRow(),
    seed: options.seed ?? [],
  };
  let wait = Promise.resolve(),
    describeEnabled = false;
  const list = vi.fn(
    options.list ??
      (async () => {
        const page = result(state.children);
        await wait;
        return page;
      }),
  );
  const described = vi.fn(async () => ({ session: state.parent }));
  const client = createTestGatewayClient(async (method, params) => {
    if (method === "sessions.describe" && describeEnabled) {
      return described();
    }
    if (method === "sessions.list") {
      return isRecord(params) && params.spawnedBy
        ? list(params)
        : result(options.primary?.() ?? []);
    }
    return { subscribed: true };
  });
  const { gateway, emitEvent } = createGatewayHarness(client);
  const sessions = createTestSessionCapability(gateway);
  const hydrator = new SwarmRosterHydrator();
  onTestFinished(() => hydrator.dispose());
  const readParent = vi.fn(options.readParent ?? (async () => state.parent));
  let params: Params = {
    sessions,
    readParent,
    parentKey: state.parent.key,
    sourceEpoch: 1,
    currentRows: () => state.seed,
  };
  const update = (changes: Partial<Params> = {}) => {
    params = { ...params, ...changes };
    hydrator.update(params);
  };
  const emit = (payload: Record<string, unknown>) =>
    emitEvent({ type: "event", event: "sessions.changed", payload });
  const fetchDescriptor = (refresh?: boolean) => {
    describeEnabled = true;
    return sessions
      .describe({ key: state.parent.key }, { refresh })
      .then(({ session }) => session ?? null);
  };
  return {
    state,
    fetchDescriptor,
    hydrator,
    sessions,
    list,
    readParent,
    described,
    update,
    emit,
    async start(changes: Partial<Params> = {}) {
      update(changes);
      await tick(250);
    },
    async boot() {
      await fetchDescriptor();
      await this.start({ readParent: fetchDescriptor });
    },
    hold(next = state.children) {
      state.children = next;
      const held = createDeferred();
      wait = held.promise;
      return held;
    },
    invalidate(key = parentRow().key, agentId = "main") {
      emit({ key, agentId, reason: "patch" });
    },
    publish(entry: Row) {
      emit({ key: entry.key, session: entry, reason: "patch" });
    },
    refreshChildren() {
      return sessions.refreshList({
        ...childSessionListQuery(parentRow().key, 10_000),
        force: true,
      });
    },
  };
}
afterEach(() => vi.useRealTimers());

it("accepts boolean/object Swarm configuration and agent overrides", () => {
  const agentConfig = (enabled: boolean, entries: unknown) => ({
    tools: { swarm: enabled },
    agents: { entries },
  });
  const cases: [unknown, string | undefined, boolean][] = [
    [undefined, "worker", true],
    [{ tools: { swarm: true } }, undefined, true],
    [{ tools: { swarm: { enabled: true } } }, undefined, true],
    [{ tools: { swarm: false } }, undefined, false],
    [{ tools: { swarm: { enabled: false } } }, undefined, false],
    [agentConfig(false, { WORKER: { tools: { swarm: true } } }), "worker", true],
    [agentConfig(true, { worker: { tools: { swarm: false } } }), "worker", false],
    [agentConfig(false, [{ id: "worker", tools: { swarm: true } }]), "worker", false],
  ];
  for (const [config, agentId, enabled] of cases) {
    expect(isSwarmEnabledInConfig(config, agentId)).toBe(enabled);
  }
});

describe("SwarmRosterHydrator", () => {
  beforeEach(() => vi.useFakeTimers());
  it("keeps collector progress and reads stable across provider completion and canonical publication", async () => {
    const children = Array.from({ length: 16 }, (_, index) => row(index, { status: "running" }));
    const parent = swarmParent(children);
    const f = fixture({ children, parent, primary: () => [summary(parent)] });
    const readParent = vi.fn(f.fetchDescriptor);
    await f.start({ readParent });
    for (let index = 0; index < children.length; index++) {
      children[index] = { ...children[index]!, status: "done", updatedAt: 100 + index };
      f.emit({
        agentId: "worker",
        reason: "lifecycle",
        session: children[index],
        ancestorSessions: [{ ...summary(parent), snapshotAt: 100 + index }],
      });
      await tick();
    }
    expect(f.hydrator.rows.find((entry) => entry.key === parent.key)?.swarm).toEqual(parent.swarm);
    await f.sessions.refresh({ agentId: "main", force: true });
    f.update();
    await tick(250);
    expect(f.hydrator.rows.filter((entry) => entry.status === "done")).toHaveLength(16);
    expect(f.hydrator.rows.find((entry) => entry.key === parent.key)?.swarm).toEqual(parent.swarm);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(readParent).toHaveBeenCalledTimes(1);
    expect(f.described).toHaveBeenCalledTimes(1);
  });

  it.each(["older group", "bounded members", "new member", "warm new member"])(
    "reconciles the initial %s roster with the shared boot descriptor",
    async (window) => {
      const grows = window.includes("new member");
      const children =
        window === "older group"
          ? [row(0), row(1, { swarmGroupId: "older-terminal-group", status: "done" })]
          : childRows(grows ? 66 : 65);
      const members = children.slice(0, window === "older group" ? 1 : 64);
      const parent = swarmParent(members, window === "older group" ? undefined : 65);
      const f = fixture({ parent, seed: window === "warm new member" ? children : [] });
      const held = f.hold(children);
      await f.boot();
      if (grows) {
        f.state.parent = swarmParent(members, 66);
      }
      held.resolve();
      await tick();
      expect(f.hydrator.hydrated).toBe(true);
      expect(f.hydrator.rows).toHaveLength(children.length + 1);
      expect(f.described).toHaveBeenCalledTimes(grows ? 2 : 1);
      if (grows) {
        expect(
          f.hydrator.rows.find((entry) => entry.key === parent.key)?.swarm?.groups[0]?.running,
        ).toBe(66);
      }
    },
  );
  it.each([
    { state: "running", shown: 1, omitted: 0, discovered: 1, reads: 2 },
    { state: "queued", shown: 1, omitted: 0, discovered: 1, reads: 2 },
    { state: "running", shown: 4, omitted: 1, discovered: 1, reads: 1 },
    { state: "running", shown: 4, omitted: 1, discovered: 2, reads: 2 },
  ] as const)(
    "reconciles $discovered unlisted $state groups with $omitted omitted",
    async ({ state, shown, omitted, discovered, reads }) => {
      const children = Array.from({ length: shown + discovered }, (_, index) =>
        row(index, { swarmGroupId: `group-${index}`, status: state }),
      );
      const groups = children.map((child, index) => ({
        groupId: `group-${index}`,
        createdAt: index < shown + omitted ? shown - index : index + 1,
        queued: Number(state === "queued"),
        running: Number(state === "running"),
        done: 0,
        failed: 0,
        children: [{ sessionKey: child.key, status: state }],
      }));
      const parent = parentRow({
        swarm: { groups: groups.slice(0, shown), otherActiveGroups: omitted },
      });
      const current = parentRow({
        swarm: {
          groups: groups.toSorted((a, b) => b.createdAt - a.createdAt).slice(0, 4),
          otherActiveGroups: Math.max(0, groups.length - 4),
        },
      });
      const f = fixture({ parent, seed: children });
      const held = f.hold(children);
      await f.boot();
      f.state.parent = current;
      held.resolve();
      await tick();
      expect(f.described).toHaveBeenCalledTimes(reads);
      expect(f.hydrator.rows.find((entry) => entry.key === parent.key)?.swarm).toEqual(
        reads === 2 ? current.swarm : parent.swarm,
      );
    },
  );
  it.each(["canonical", "filtered"])(
    "revalidates a %s summary during initial describe",
    async (source) => {
      const stale = createDeferred<Row>();
      const initial = { ...swarmParent([row(0)]), updatedAt: 1 };
      const current = { ...swarmParent([row(0), row(1)]), updatedAt: 2 };
      const f = fixture({
        primary: () => [summary(current)],
        readParent: vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(current),
      });
      await f.start();
      if (source === "canonical") {
        await f.sessions.refresh({ agentId: "main", force: true });
      } else {
        await f.sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
      }
      expect(f.hydrator.rows).toEqual([summary(current)]);
      stale.resolve(initial);
      await tick();
      expect(f.hydrator.rows).toEqual([current]);
    },
  );
  it.each(["first page", "overlapping describe"])(
    "rechecks changed membership after %s",
    async (phase) => {
      const stale = createDeferred<Row>(),
        page = createDeferred<SessionsListResult>();
      const initial = swarmParent([row(0)]),
        current = swarmParent([row(1)]);
      const readParent = vi.fn().mockResolvedValueOnce(initial);
      if (phase === "overlapping describe") {
        readParent.mockReturnValueOnce(stale.promise);
      }
      readParent.mockResolvedValue(current);
      const f = fixture({
        children: [row(0)],
        readParent,
        ...(phase === "first page" ? { list: () => page.promise } : {}),
      });
      await f.start();
      if (phase === "first page") {
        expect(f.hydrator.rows).toEqual([initial]);
        page.resolve(result([row(1)]));
      } else {
        f.invalidate();
        await tick();
        f.state.children = [row(1)];
        f.publish(row(1));
        await tick(5_000);
        stale.resolve(initial);
      }
      await tick();
      expect(f.hydrator.rows).toEqual([expect.objectContaining({ key: row(1).key }), current]);
    },
  );
  it.each([0, 1])(
    "waits for the post-launch read when already holding %i children",
    async (count) => {
      const f = fixture({
        children: childRows(count),
        readParent: async () => namedParent(f.state.children),
      });
      const hydration: boolean[] = [];
      onTestFinished(
        f.hydrator.subscribe(() =>
          hydration.push(f.hydrator.hydrated && !f.hydrator.pendingChildRead),
        ),
      );
      await f.start();
      expect(f.hydrator.hydrated).toBe(true);
      const previous = f.hold(),
        refresh = f.refreshChildren();
      await tick();
      const reads = f.list.mock.calls.length,
        held = f.hold([...f.state.children, row(count)]);
      f.invalidate();
      await tick();
      expect(f.hydrator.hydrated).toBe(false);
      expect(f.list).toHaveBeenCalledTimes(reads);
      hydration.length = 0;
      previous.resolve();
      await tick();
      expect(f.list).toHaveBeenCalledTimes(reads + 1);
      expect(f.hydrator).toMatchObject({
        hydrated: true,
        pendingChildRead: true,
        childrenRead: true,
      });
      expect(hydration.length).toBeGreaterThan(0);
      expect(hydration.every((loaded) => !loaded)).toBe(true);
      held.resolve();
      await refresh;
      await tick();
      expect(f.hydrator).toMatchObject({ hydrated: true, pendingChildRead: false });
      expect(f.hydrator.rows.map(({ key }) => key)).toContain(row(count).key);
    },
  );
  it("retains a newer failed read's retry when older pagination finishes", async () => {
    const first = createDeferred<SessionsListResult>(),
      last = createDeferred<SessionsListResult>();
    let reads = 0;
    const f = fixture({
      children: childRows(2),
      readParent: async () => namedParent(f.state.children),
      list: async (options: SessionListOptions = {}) => {
        if (options.offset === 1) {
          return last.promise;
        }
        reads++;
        if (reads === 2) {
          return first.promise;
        }
        if (reads === 3) {
          throw new Error("Child list temporarily unavailable");
        }
        return result(f.state.children);
      },
    });
    await f.start();
    expect(f.hydrator.hydrated).toBe(true);
    const refresh = f.refreshChildren();
    await tick();
    f.state.children = childRows(3);
    f.invalidate();
    await tick();
    first.resolve(result([row(0)], 0, 2));
    await refresh;
    await tick();
    expect(reads).toBe(3);
    last.resolve(result([row(1)], 1, 2));
    await tick();
    expect(f.hydrator.pendingChildRead).toBe(true);
    await tick(1_000);
    expect(reads).toBe(4);
    expect(f.hydrator.hydrated).toBe(true);
    expect(f.hydrator.rows.map(({ key }) => key)).toContain(row(2).key);
  });
  it("asks once for an absent named child without blocking later launches", async () => {
    const f = fixture({
      children: [row(0)],
      readParent: async () =>
        parentRow({
          childSessions: [
            ...f.state.children.map(({ key }) => key),
            "agent:worker:subagent:archived",
          ],
        }),
    });
    await f.start();
    expect(f.hydrator.hydrated).toBe(true);
    const reads = f.list.mock.calls.length;
    f.invalidate();
    await tick(250);
    expect(f.list).toHaveBeenCalledTimes(reads);
    const held = f.hold(childRows(2));
    f.invalidate();
    await tick();
    expect(f.list).toHaveBeenCalledTimes(reads + 1);
    expect(f.hydrator).toMatchObject({ hydrated: false, childrenRead: true });
    held.resolve();
    await tick(250);
    expect(f.hydrator.hydrated).toBe(true);
    expect(f.list).toHaveBeenCalledTimes(reads + 1);
  });
  it("keeps a fetched tie winner over the seed but accepts a later event", async () => {
    const running = row(0, { status: "running", updatedAt: 5 });
    const f = fixture({ children: [row(0, { status: "done", updatedAt: 5 })], seed: [running] });
    const statuses = () =>
      f.hydrator.rows.filter(({ key }) => key !== parentRow().key).map(({ status }) => status);
    await f.start();
    expect(statuses()).toEqual(["done"]);
    f.update();
    expect(statuses()).toEqual(["done"]);
    const changed = { ...running, status: "failed" as const };
    f.state.seed = [changed];
    f.publish(changed);
    f.update();
    await tick();
    expect(statuses()).toEqual(["failed"]);
  });
  it("backs off parent failures without reloading healthy children", async () => {
    let attempts = 0;
    const f = fixture({
      children: [row(0)],
      readParent: async () => {
        if (++attempts <= 4) {
          throw new Error("parent unavailable");
        }
        return parentRow();
      },
    });
    await f.start();
    expect(attempts).toBe(1);
    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await tick(delay - 1);
      expect(attempts).toBe(index + 1);
      await tick(1);
      expect(attempts).toBe(index + 2);
      expect(f.list).toHaveBeenCalledTimes(1);
    }
    expect(f.hydrator.rows.map(({ key }) => key)).toEqual([row(0).key, parentRow().key]);
  });
  it("fences an old global owner read and does not resurrect a denied parent", async () => {
    const old = createDeferred<Row>();
    const global = (agentId: string): Row => ({
      key: "global",
      kind: "global",
      agentId,
      sessionId: `${agentId}-global-session`,
    });
    const main = global("main"),
      other = global("other");
    const f = fixture({ parent: main, seed: [main], readParent: () => old.promise });
    await f.start({ agentId: "main" });
    await f.start({ agentId: "other", readParent: async () => other });
    expect(f.hydrator.rows).toEqual([other]);
    old.resolve(main);
    await tick();
    expect(f.hydrator.rows).toEqual([other]);
    f.update({ readParent: async () => null });
    f.invalidate("global", "other");
    await tick(250);
    expect(f.hydrator.rows).toEqual([]);
    f.update();
    expect(f.hydrator.rows).toEqual([]);
  });
  it("publishes parent counts before optional children and keeps them after failure", async () => {
    const children = createDeferred<SessionsListResult>();
    const parent = summary(swarmParent([], 0));
    Object.assign(parent.swarm!.groups[0]!, { done: 25, failed: 5 });
    const f = fixture({ parent, list: () => children.promise });
    await f.start();
    expect(f.hydrator.rows).toEqual([parent]);
    expect(f.hydrator.childrenUnavailable).toBe(false);
    children.reject(new Error("Child details temporarily unavailable"));
    await tick();
    expect(f.hydrator.rows).toEqual([parent]);
    expect(f.hydrator.childrenUnavailable).toBe(true);
    f.list.mockResolvedValue(result([]));
    await tick(1_000);
    expect(f.hydrator.childrenUnavailable).toBe(false);
  });
  it.each(["missing", "denied"])(
    "does not restore a %s parent after late child completion",
    async (outcome) => {
      const children = createDeferred<SessionsListResult>(),
        parent = summary(swarmParent([], 1));
      const f = fixture({
        parent,
        seed: [parent],
        list: vi.fn().mockReturnValueOnce(children.promise).mockResolvedValue(result([])),
      });
      const onRows = vi.fn();
      onTestFinished(f.hydrator.subscribe(() => onRows(f.hydrator.rows)));
      await f.start();
      expect(f.hydrator.rows).toEqual([parent]);
      f.update({
        readParent: async () => {
          if (outcome === "denied") {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Parent unavailable",
            });
          }
          return null;
        },
      });
      f.invalidate();
      await tick(250);
      expect(f.hydrator.rows).toEqual([]);
      f.state.seed = [parent, row(0, { label: "Changed after denial" })];
      f.update();
      expect(f.hydrator.rows).toEqual([]);
      children.resolve(result([row(0)]));
      await tick();
      expect(f.hydrator.rows).toEqual([]);
      expect(onRows).toHaveBeenLastCalledWith([]);
    },
  );
});

it("restarts pagination when updated rows move across offset boundaries", async () => {
  const running = row(1, { status: "running" }),
    done = row(1, { status: "done", updatedAt: 10 });
  const pages = [
    [row(0), running],
    [running, row(2)],
    [row(3), row(0)],
    [done, row(2)],
  ];
  let index = 0;
  const f = fixture({
    list: async (options: SessionListOptions = {}) =>
      result(pages[index++] ?? [], options.offset ?? 0, 4),
  });
  const rows = await hydrateSwarmSessionRows({
    sessions: f.sessions,
    parentKey: parentRow().key,
    isCurrent: () => true,
  });
  expect(rows?.map(({ key }) => key).toSorted()).toEqual(
    childRows(4)
      .map(({ key }) => key)
      .toSorted(),
  );
  expect(rows?.find(({ key }) => key === done.key)?.status).toBe("done");
  expect(f.list).toHaveBeenCalledTimes(4);
});
it("merges fresh and tied rows without changing their insertion order", () => {
  const stale = row(0, { status: "running", updatedAt: 5 }),
    fresh = row(0, { status: "done", updatedAt: 6 });
  expect(mergeSwarmSessionRows([fresh], [stale])).toEqual([fresh]);
  expect(mergeSwarmSessionRows([stale], [fresh])).toEqual([fresh]);
  const changed = { ...fresh, status: "failed" as const };
  expect(mergeSwarmSessionRows([stale, row(1)], [fresh, parentRow()], [changed, row(2)])).toEqual([
    changed,
    row(1),
    parentRow(),
    row(2),
  ]);
});
