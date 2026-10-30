// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { useSessionActivityControllerFixture } from "./session-activity-controller.test-support.ts";

const { active, listing, setup } = useSessionActivityControllerFixture();
let fixture: ReturnType<typeof setup>;
beforeEach(() => {
  vi.useFakeTimers();
  fixture = setup();
});

function snapshot(
  session: GatewaySessionRow,
  ancestorSessions: GatewaySessionRow[] = [],
  reason?: string,
) {
  return { agentId: active.agentId, session, ancestorSessions, reason };
}

function sample(row: GatewaySessionRow, at: number, fields: Partial<GatewaySessionRow> = {}) {
  return { ...row, updatedAt: at, snapshotAt: at, ...fields };
}

function makeSession(name: string, fields: Partial<GatewaySessionRow> = {}) {
  return { ...active, key: `agent:work:${name}`, sessionId: `${name}-session`, ...fields };
}

function settled<T extends { key: string }>(row: T, updatedAt: number) {
  return { ...row, updatedAt, hasActiveRun: false, activeRunIds: [], status: "done" as const };
}

function completion(runId: string, fields: Partial<GatewaySessionRow> = {}) {
  const { key, agentId, sessionId } = active;
  return { key, agentId, sessionId, runId, status: "done", ...fields };
}

function ancestorRef(row: GatewaySessionRow, revision: string) {
  return { key: row.key, sessionId: row.sessionId, revision, snapshotAt: 300 };
}

function pendingRefresh(query: Parameters<typeof fixture.controller.load>[1] = "current") {
  const { request, controller, client } = fixture;
  const pending = createDeferred<SessionsListResult>();
  request.mockReturnValueOnce(pending.promise);
  void controller.load(client, query, "refresh");
  return pending;
}

function expectRows(
  rows: GatewaySessionRow[],
  state?: Partial<Pick<typeof fixture.controller, "incomplete" | "loading" | "error">>,
) {
  expect(fixture.controller.result?.sessions).toEqual(rows);
  if (state) {
    expect(fixture.controller).toMatchObject(state);
  }
}

async function advance(ms: number, calls: number) {
  await vi.advanceTimersByTimeAsync(ms);
  expect(fixture.request).toHaveBeenCalledTimes(calls);
}

it("publishes usable snapshots while new work keeps starting during refresh", async () => {
  const { client, request, controller } = fixture;
  request.mockResolvedValueOnce(listing([]));
  await controller.load(client, "current");
  const responses = Array.from({ length: 4 }, () => createDeferred<SessionsListResult>());
  for (const response of responses) {
    request.mockReturnValueOnce(response.promise);
  }
  void controller.load(client, "current", "refresh");
  const observed: Array<GatewaySessionRow[] | undefined> = [];
  for (let round = 0; round < 3; round += 1) {
    const transient = {
      key: `agent:work:transient-${round}`,
      agentId: "work",
      sessionId: `transient-session-${round}`,
      runId: `transient-run-${round}`,
      updatedAt: 200 + round * 2,
    };
    controller.invalidate({
      ...transient,
      hasActiveRun: true,
      activeRunIds: [transient.runId],
      status: "running",
    });
    responses[round]!.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(0);
    observed.push(controller.result?.sessions);
    // This short turn finishes before the next snapshot captures membership.
    controller.invalidate(settled(transient, transient.updatedAt + 1));
    await advance(4_999, 2 + round);
    await advance(1, 3 + round);
  }
  expect(controller.incomplete).toBe(true);
  responses[3]!.resolve(listing([active]));
  await vi.advanceTimersByTimeAsync(0);
  expectRows([active], { loading: false });
  expect(observed).toEqual([[active], [active], [active]]);
  expect(request).toHaveBeenCalledTimes(5);
});

it("keeps an incomplete empty snapshot loading and permits retry after catch-up fails", async () => {
  const { client, request, controller } = fixture;
  const pending = createDeferred<SessionsListResult>();
  request.mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error("Unavailable"));
  void controller.load(client, "current");
  controller.invalidate({ ...active, updatedAt: 200 });
  pending.resolve(listing([]));
  await vi.advanceTimersByTimeAsync(0);
  expectRows([], { incomplete: true, loading: true });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(controller).toMatchObject({ error: "Unavailable", loading: false });
  await controller.load(client, "current", "retry");
  expectRows([active], { error: undefined, incomplete: false });
});

it.each([
  { name: "current work", query: "current" as const },
  { name: "history", query: { personId: null, time: "all" as const, query: "release" } },
])("retains $name through reconnect and retires it on client replacement", async ({ query }) => {
  const { client, request, controller } = fixture;
  await controller.load(client, query);
  const stale = pendingRefresh(query);
  void controller.load(client, query, "query", false, false);
  expectRows([active], { loading: false });
  stale.resolve(listing([]));
  await vi.advanceTimersByTimeAsync(0);
  expectRows([active]);
  request.mockRejectedValueOnce(new Error("refresh unavailable"));
  await controller.load(client, query);
  expectRows([active], { error: "refresh unavailable" });
  const fresh = createDeferred<SessionsListResult>();
  request.mockReturnValueOnce(fresh.promise);
  void controller.load(client, query, "retry");
  expectRows([active]);
  fresh.resolve(listing([]));
  await vi.advanceTimersByTimeAsync(0);
  expectRows([]);
  const replacement = setup();
  const replacementRead = createDeferred<SessionsListResult>();
  replacement.request.mockReturnValueOnce(replacementRead.promise);
  void controller.load(replacement.client, query);
  expect(controller.result).toBeUndefined();
  replacementRead.resolve(listing([active]));
  await vi.advanceTimersByTimeAsync(0);
  expectRows([active]);
});

it.each([
  { bothFinish: true, hasMore: false, newer: false },
  { bothFinish: false, hasMore: true, newer: true },
])(
  "reconciles overlapping completions during a snapshot (both finish: $bothFinish, truncated: $hasMore, newer: $newer)",
  async ({ bothFinish, hasMore, newer }) => {
    const { client, request, controller, publications } = fixture;
    const overlap = sample(active, 200, {
      activeRunIds: ["release-run", "overlap-run"],
    });
    const initial = {
      ...listing([active]),
      hasMore,
      ...(hasMore ? { limitApplied: 1, totalCount: 2 } : {}),
    };
    request.mockResolvedValueOnce(initial);
    await controller.load(client, "current");
    const stale = pendingRefresh();
    if (bothFinish) {
      controller.invalidate({ ...overlap, updatedAt: 150, snapshotAt: undefined });
    }
    controller.invalidate(snapshot(overlap));
    controller.invalidate(completion("release-run", { updatedAt: 250 }));
    expect(controller.result?.sessions[0]?.activeRunIds).toEqual(["overlap-run"]);
    if (bothFinish) {
      controller.invalidate(completion("overlap-run", { updatedAt: 250 }));
      expect(controller.result?.sessions).toEqual([]);
    }
    controller.invalidate(
      snapshot(
        sample(overlap, newer ? 300 : 230, {
          activeRunIds: newer ? ["overlap-run"] : overlap.activeRunIds,
        }),
      ),
    );
    const terminalPublication = publications.length;
    stale.resolve(initial);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.result?.sessions.map((row) => row.activeRunIds)).toEqual(
      bothFinish ? [] : [["overlap-run"]],
    );
    expect(
      publications
        .slice(terminalPublication)
        .some((rows) => rows?.some((row) => row.activeRunIds?.includes("release-run"))),
    ).toBe(false);
    await advance(5_000, 2);
  },
);

it("uses canonical replacement liveness before a delayed old completion", async () => {
  const { client, request, controller } = fixture;
  const replacement = {
    ...active,
    updatedAt: 200,
    status: "queued" as const,
    activeRunIds: undefined,
  };
  const latest = sample(replacement, 230);
  await controller.load(client, "current");
  controller.invalidate(completion("retired-run", { hasActiveRun: false }));
  expectRows([active]);
  const stale = pendingRefresh();
  request.mockResolvedValue(listing([latest]));
  controller.invalidate({ ...replacement, runId: "next-run", activeRunIds: null });
  expectRows([replacement]);
  controller.invalidate(
    completion("release-run", {
      updatedAt: 250,
      hasActiveRun: false,
      activeRunIds: [],
    }),
  );
  expectRows([replacement]);
  controller.invalidate(snapshot(latest));
  stale.resolve(listing([active]));
  await vi.advanceTimersByTimeAsync(0);
  expectRows([latest], { incomplete: true });
  await advance(5_000, 3);
  expectRows([latest]);
});

it("refreshes a conflicting delete generation without confusing global owners during a read", async () => {
  const { client, request, controller } = fixture;
  const globalRow = { ...active, key: "global", kind: "global" as const };
  const main = { ...globalRow, agentId: "main", sessionId: "main-global" };
  const work = { ...globalRow, agentId: "work", sessionId: "work-global" };
  const literal = makeSession("global", { sessionId: "literal-global" });
  const initial = listing([main, work, literal]);
  request.mockResolvedValueOnce(initial).mockResolvedValue({ ...listing([literal]), ts: 300 });
  await controller.load(client, "current");
  const stale = pendingRefresh();
  controller.invalidate(settled(main, 200));
  controller.invalidate({
    sessionKey: work.key,
    agentId: work.agentId,
    sessionId: "replacement-work-global",
    reason: "delete",
    ts: 201,
  });
  stale.resolve(initial);
  await vi.advanceTimersByTimeAsync(0);
  expectRows([literal, work], { incomplete: true });
  await advance(5_000, 3);
  expectRows([literal], { incomplete: false });
});

it.each(["current", { personId: null, time: "all", query: "" }] as const)(
  "retains certified rows through a busy overlapping %j read without overflowing",
  async (query) => {
    // Keep the busy-read assertion separate from the owner's midnight rollover.
    vi.setSystemTime(new Date(2026, 0, 15, 12));
    const { client, request, controller } = fixture;
    await controller.load(client, query);
    const pending = pendingRefresh(query);
    for (let revision = 1; revision <= 1_500; revision += 1) {
      const row = sample(active, 100 + revision, { label: `Revision ${revision}` });
      controller.invalidate(snapshot(row, [], "patch"));
    }
    if (query === "current") {
      const delayed = sample(active, 1_600, { snapshotAt: 1_599, label: "Delayed sample" });
      controller.invalidate(snapshot(delayed, [], "patch"));
    }
    pending.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(59_999);
    expectRows([sample(active, 1_600, { label: "Revision 1500" })], { loading: false });
    expect(request).toHaveBeenCalledTimes(2);
    await advance(5_001, 3);
  },
);

it("excludes certified dock snapshots from current work even with space", async () => {
  const { client, request, controller } = fixture;
  request.mockResolvedValue({ ...listing([active]), hasMore: false, limitApplied: 100 });
  await controller.load(client, "current");
  const added = sample(makeSession("new", { isDock: true }), 200);
  controller.invalidate(snapshot(added, [], "agent.run.started"));
  expectRows([active]);
  await advance(5_000, 1);
});

it("refreshes held parent facts after uncertified child completion during a read", async () => {
  const { client, request, controller } = fixture;
  const group = { groupId: "work", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 };
  const parent = makeSession("parent", {
    activeRunIds: ["parent-run"],
    hasActiveSubagentRun: true,
    swarm: { groups: [group], otherActiveGroups: 0 },
  });
  const child = { ...active, parentSessionKey: parent.key };
  const settledParent = {
    ...parent,
    updatedAt: 300,
    hasActiveSubagentRun: false,
    swarm: { groups: [{ ...group, running: 0, done: 1 }], otherActiveGroups: 0 },
  };
  const initial = listing([child, parent]);
  request
    .mockResolvedValueOnce(initial)
    .mockResolvedValue({ ...listing([settledParent]), ts: 300 });
  await controller.load(client, "current");
  const stale = pendingRefresh();
  controller.invalidate(snapshot({ ...settled(child, 200), snapshotAt: 200 }));
  expectRows([parent], { incomplete: true });
  stale.resolve(initial);
  await vi.advanceTimersByTimeAsync(0);
  expectRows([parent], { incomplete: true });
  await advance(5_000, 3);
  expectRows([settledParent], { incomplete: false });
});

it("applies certified ancestor rows and references without refetching current work during a read", async () => {
  const { client, request, controller } = fixture;
  const parent = makeSession("parent", {
    label: "Parent before settlement",
    snapshotAt: 100,
    hasActiveSubagentRun: true,
    childSessions: [active.key],
    parentSessionKey: "agent:work:grandparent",
  });
  const grandparent = makeSession("grandparent", {
    childSessions: [parent.key],
    snapshotAt: 100,
  });
  const child = { ...active, parentSessionKey: parent.key, snapshotAt: 100 };
  const heldParent = () => controller.result?.sessions.find((row) => row.key === parent.key);
  const changeAncestors = (at: number, rows: GatewaySessionRow[]) => {
    controller.invalidate(snapshot(sample(child, at), rows, "subagent-status"));
  };
  request.mockResolvedValue(listing([child, parent, grandparent]));
  await controller.load(client, "current");
  const stale = pendingRefresh();
  const updatedParent = {
    ...parent,
    label: "Parent after settlement",
    updatedAt: 150,
    snapshotAt: 200,
    status: "queued" as const,
    hasActiveSubagentRun: false,
  };
  const inactive = {
    ...updatedParent,
    key: "agent:work:inactive-ancestor",
    sessionId: "inactive-ancestor",
    ancestorRevision: "inactive-ancestor-revision",
    hasActiveRun: false,
    status: "done" as const,
  };
  changeAncestors(200, [
    { ...updatedParent, ancestorRevision: "parent-revision" },
    { ...grandparent, snapshotAt: 200, ancestorRevision: "grandparent-revision" },
    inactive,
  ]);
  expect(heldParent()).toEqual(updatedParent);
  const reference = ancestorRef(parent, "parent-revision");
  controller.invalidate({
    ...snapshot(sample(child, 300), [], "subagent-status"),
    ancestorSessionRefs: [
      reference,
      ancestorRef(grandparent, "grandparent-revision"),
      ancestorRef(inactive, inactive.ancestorRevision),
    ],
  });
  changeAncestors(250, [
    {
      ...updatedParent,
      label: "Delayed parent snapshot",
      updatedAt: 175,
      snapshotAt: 250,
      ancestorRevision: "delayed-parent-revision",
    },
  ]);
  const referencedParent = { ...updatedParent, snapshotAt: 300 };
  expect(heldParent()).toEqual(referencedParent);
  stale.resolve(listing([child, parent, grandparent]));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(heldParent()).toEqual(referencedParent);
  expect(controller.result?.sessions).toHaveLength(3);
  expect(request).toHaveBeenCalledTimes(2);
  controller.invalidate({
    ...snapshot(sample(child, 301)),
    ancestorSessionRefs: [{ ...reference, sessionId: "retired-parent", snapshotAt: 301 }],
  });
  expect(heldParent()?.sessionId).toBe(parent.sessionId);
  await advance(5_000, 3);
});
