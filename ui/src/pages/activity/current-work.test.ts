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

function settled<T extends { key: string }>(row: T, updatedAt: number) {
  return { ...row, updatedAt, hasActiveRun: false, activeRunIds: [], status: "done" as const };
}

function ancestorRef(key: string, sessionId: string | undefined, revision: string) {
  return { key, sessionId, revision, snapshotAt: 300 };
}

function pendingRefresh(query: Parameters<typeof fixture.controller.load>[1] = "current") {
  const { request, controller, client } = fixture;
  const pending = createDeferred<SessionsListResult>();
  request.mockReturnValueOnce(pending.promise);
  void controller.load(client, query, "refresh");
  return pending;
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
    await vi.advanceTimersByTimeAsync(4_999);
    expect(request).toHaveBeenCalledTimes(2 + round);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3 + round);
  }
  expect(controller.incomplete).toBe(true);
  responses[3]!.resolve(listing([active]));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.result?.sessions).toEqual([active]);
  expect(controller.loading).toBe(false);
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
  expect(controller.result?.sessions).toEqual([]);
  expect(controller.incomplete).toBe(true);
  expect(controller.loading).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(controller.error).toBe("Unavailable");
  expect(controller.loading).toBe(false);
  await controller.load(client, "current", "retry");
  expect(controller.error).toBeUndefined();
  expect(controller.result?.sessions).toEqual([active]);
  expect(controller.incomplete).toBe(false);
});

it("retires current work on disconnect and only accepts the replacement query", async () => {
  const { client, request, controller } = fixture;
  await controller.load(client, "current");
  const stale = pendingRefresh();
  void controller.load(null, null);
  expect(controller.result).toBeUndefined();
  expect(controller.incomplete).toBe(false);
  request.mockResolvedValue(listing([]));
  void controller.load(client, "current");
  stale.resolve(listing([active]));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.result?.sessions).toEqual([]);
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
    const terminal = {
      key: active.key,
      agentId: active.agentId,
      sessionId: active.sessionId,
      updatedAt: 250,
      status: "done",
    };
    controller.invalidate({ ...terminal, runId: "release-run" });
    expect(controller.result?.sessions[0]?.activeRunIds).toEqual(["overlap-run"]);
    if (bothFinish) {
      controller.invalidate({ ...terminal, runId: "overlap-run" });
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
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(2);
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
  const stale = pendingRefresh();
  request.mockResolvedValue(listing([latest]));
  controller.invalidate({ ...replacement, runId: "next-run", activeRunIds: null });
  expect(controller.result?.sessions).toEqual([replacement]);
  controller.invalidate({
    key: active.key,
    agentId: active.agentId,
    sessionId: active.sessionId,
    updatedAt: 250,
    runId: "release-run",
    hasActiveRun: false,
    activeRunIds: [],
    status: "done",
  });
  expect(controller.result?.sessions).toEqual([replacement]);
  controller.invalidate(snapshot(latest));
  stale.resolve(listing([active]));
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.result?.sessions).toEqual([latest]);
  expect(controller.incomplete).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(controller.result?.sessions).toEqual([latest]);
  expect(request).toHaveBeenCalledTimes(3);
});

it("keeps a replacement run after an older terminal event", async () => {
  const { client, controller } = fixture;
  await controller.load(client, "current");
  controller.invalidate({
    key: active.key,
    agentId: active.agentId,
    sessionId: active.sessionId,
    runId: "retired-run",
    status: "done",
    hasActiveRun: false,
  });
  expect(controller.result?.sessions).toEqual([active]);
});

it("refreshes a conflicting delete generation without confusing global owners during a read", async () => {
  const { client, request, controller } = fixture;
  const globalRow = { ...active, key: "global", kind: "global" as const };
  const main = { ...globalRow, agentId: "main", sessionId: "main-global" };
  const work = { ...globalRow, agentId: "work", sessionId: "work-global" };
  const literal = { ...active, key: "agent:work:global", sessionId: "literal-global" };
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
  expect(controller.result?.sessions).toEqual([literal, work]);
  expect(controller.incomplete).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(controller.result?.sessions).toEqual([literal]);
  expect(controller.incomplete).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each(["current", { personId: null, time: "all", query: "" }] as const)(
  "retains certified rows through a busy overlapping %j read without overflowing",
  async (query) => {
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
    expect(controller.result?.sessions).toEqual([
      sample(active, 1_600, { label: "Revision 1500" }),
    ]);
    expect(controller.loading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it("excludes certified dock snapshots from current work even with space", async () => {
  const { client, request, controller } = fixture;
  request.mockResolvedValue({ ...listing([active]), hasMore: false, limitApplied: 100 });
  await controller.load(client, "current");
  const added = sample(active, 200, {
    key: "agent:work:new",
    sessionId: "new-session",
    isDock: true,
  });
  controller.invalidate(snapshot(added, [], "agent.run.started"));
  expect(controller.result?.sessions).toEqual([active]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(1);
});

it("refreshes held parent facts after uncertified child completion during a read", async () => {
  const { client, request, controller } = fixture;
  const group = { groupId: "work", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 };
  const parent = {
    ...active,
    key: "agent:work:parent",
    sessionId: "parent-session",
    activeRunIds: ["parent-run"],
    hasActiveSubagentRun: true,
    swarm: { groups: [group], otherActiveGroups: 0 },
  };
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
  expect(controller.result?.sessions).toEqual([parent]);
  expect(controller.incomplete).toBe(true);
  stale.resolve(initial);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.result?.sessions).toEqual([parent]);
  expect(controller.incomplete).toBe(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(controller.result?.sessions).toEqual([settledParent]);
  expect(controller.incomplete).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});

it("applies certified ancestor rows and references without refetching current work during a read", async () => {
  const { client, request, controller } = fixture;
  const parent = {
    ...active,
    key: "agent:work:parent",
    sessionId: "parent-session",
    label: "Parent before settlement",
    snapshotAt: 100,
    hasActiveSubagentRun: true,
    childSessions: [active.key],
    parentSessionKey: "agent:work:grandparent",
  };
  const grandparent = {
    ...active,
    key: parent.parentSessionKey,
    sessionId: "grandparent-session",
    childSessions: [parent.key],
    snapshotAt: 100,
  };
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
  changeAncestors(200, [
    { ...updatedParent, ancestorRevision: "parent-revision" },
    { ...grandparent, snapshotAt: 200, ancestorRevision: "grandparent-revision" },
    {
      ...updatedParent,
      key: "agent:work:inactive-ancestor",
      sessionId: "inactive-ancestor",
      ancestorRevision: "inactive-ancestor-revision",
      hasActiveRun: false,
      status: "done",
    },
  ]);
  expect(heldParent()).toEqual(updatedParent);
  const reference = ancestorRef(parent.key, parent.sessionId, "parent-revision");
  controller.invalidate({
    ...snapshot(sample(child, 300), [], "subagent-status"),
    ancestorSessionRefs: [
      reference,
      ancestorRef(grandparent.key, grandparent.sessionId, "grandparent-revision"),
      ancestorRef(
        "agent:work:inactive-ancestor",
        "inactive-ancestor",
        "inactive-ancestor-revision",
      ),
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
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledTimes(3);
});
