// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { useSessionActivityControllerFixture } from "./session-activity-controller.test-support.ts";

const { active, listing, setup } = useSessionActivityControllerFixture();

it("loads a bounded current-work query independently of chat, people, and recency", async () => {
  const { client, request, controller } = setup();
  void controller.load(client, "current");
  await vi.waitFor(() => expect(controller.result?.sessions).toEqual([active]));
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "sessions.list",
    {
      rowMode: "compact",
      source: "activity",
      activeOnly: true,
      excludeDock: true,
      archived: "all",
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      limit: 100,
    },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it.each([false, true])(
  "publishes usable snapshots while new work keeps starting (refresh: %s)",
  async (refresh) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    if (refresh) {
      request.mockResolvedValueOnce(listing([]));
      void controller.load(client, "current");
      await vi.advanceTimersByTimeAsync(0);
    }
    const responses = Array.from({ length: 4 }, () => createDeferred<SessionsListResult>());
    for (const response of responses) {
      request.mockReturnValueOnce(response.promise);
    }
    void controller.load(client, "current", refresh ? "refresh" : "query");
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
      controller.invalidate({
        ...transient,
        updatedAt: transient.updatedAt + 1,
        hasActiveRun: false,
        activeRunIds: [],
        status: "done",
      });
      const catchUpDelay = 5_000;
      await vi.advanceTimersByTimeAsync(catchUpDelay - 1);
      expect(request).toHaveBeenCalledTimes((refresh ? 2 : 1) + round);
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes((refresh ? 3 : 2) + round);
    }
    expect(controller.incomplete).toBe(true);
    responses[3]!.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.result?.sessions).toEqual([active]);
    expect(controller.loading).toBe(false);
    expect(observed).toEqual([[active], [active], [active]]);
    expect(request).toHaveBeenCalledTimes(refresh ? 5 : 4);
  },
);

it("keeps an incomplete empty snapshot loading and permits retry after catch-up fails", async () => {
  vi.useFakeTimers();
  const { client, request, controller } = setup();
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
  void controller.load(client, "current", "retry");
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.error).toBeUndefined();
  expect(controller.result?.sessions).toEqual([active]);
  expect(controller.incomplete).toBe(false);
});

it.each([false, true])(
  "does not resurrect completed work after a stale snapshot (another turn: %s)",
  async (anotherTurn) => {
    vi.useFakeTimers();
    const { client, request, controller, publications } = setup();
    void controller.load(client, "current");
    await vi.advanceTimersByTimeAsync(0);
    const stale = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(stale.promise).mockResolvedValue(listing([]));
    void controller.load(client, "current", "refresh");
    controller.invalidate({
      ...active,
      updatedAt: 200,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    });
    expect(controller.result?.sessions).toEqual([]);
    if (anotherTurn) {
      controller.invalidate({
        ...active,
        updatedAt: 201,
        runId: "next-run",
        activeRunIds: ["next-run"],
        status: "running",
      });
      controller.invalidate({
        ...active,
        updatedAt: 202,
        runId: "next-run",
        hasActiveRun: false,
        activeRunIds: [],
        status: "done",
      });
    }
    const terminalPublication = publications.length;
    stale.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.result?.sessions).toEqual([]);
    expect(
      publications.slice(terminalPublication).some((rows) => rows?.some((row) => row.hasActiveRun)),
    ).toBe(false);
    expect(request).toHaveBeenCalledTimes(anotherTurn ? 3 : 2);
  },
);

it("retires current work on disconnect and only accepts the replacement query", async () => {
  vi.useFakeTimers();
  const { client, request, controller } = setup();
  void controller.load(client, "current");
  await vi.advanceTimersByTimeAsync(0);
  const stale = createDeferred<SessionsListResult>();
  request.mockReturnValueOnce(stale.promise);
  void controller.load(client, "current", "refresh");
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
  { bothFinish: false, hasMore: false, newer: false },
  { bothFinish: true, hasMore: false, newer: false },
  { bothFinish: false, hasMore: true, newer: true },
])(
  "reconciles overlapping completions during a snapshot (both finish: $bothFinish, truncated: $hasMore, newer: $newer)",
  async ({ bothFinish, hasMore, newer }) => {
    vi.useFakeTimers();
    const { client, request, controller, publications } = setup();
    const overlap = {
      ...active,
      updatedAt: 200,
      snapshotAt: 200,
      activeRunIds: ["release-run", "overlap-run"],
    };
    const initial = {
      ...listing([active]),
      hasMore,
      ...(hasMore ? { limitApplied: 1, totalCount: 2 } : {}),
    };
    request.mockResolvedValueOnce(initial);
    await controller.load(client, "current");
    const stale = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(stale.promise);
    void controller.load(client, "current", "refresh");
    if (bothFinish) {
      controller.invalidate({ ...overlap, updatedAt: 150, snapshotAt: undefined });
    }
    controller.invalidate({ agentId: active.agentId, session: overlap, ancestorSessions: [] });
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
    controller.invalidate({
      agentId: active.agentId,
      session: {
        ...overlap,
        updatedAt: newer ? 300 : 230,
        snapshotAt: newer ? 300 : 230,
        activeRunIds: newer ? ["overlap-run"] : overlap.activeRunIds,
      },
      ancestorSessions: [],
    });
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

it.each([{ activeRunIds: ["next-run"] }, { activeRunIds: null }])(
  "uses canonical replacement liveness before a delayed old completion (run IDs: %j)",
  async ({ activeRunIds }) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    const replacement = {
      ...active,
      updatedAt: 200,
      status: "queued" as const,
      activeRunIds: activeRunIds ?? undefined,
    };
    const latest = { ...replacement, updatedAt: 230, snapshotAt: 230 };
    await controller.load(client, "current");
    const stale = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(stale.promise).mockResolvedValue(listing([latest]));
    void controller.load(client, "current", "refresh");
    controller.invalidate({ ...replacement, runId: "next-run", activeRunIds });
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
    controller.invalidate({ agentId: active.agentId, session: latest, ancestorSessions: [] });
    stale.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.result?.sessions).toEqual([latest]);
    expect(controller.incomplete).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.result?.sessions).toEqual([latest]);
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it.each([false, undefined])(
  "keeps a replacement run after an older terminal event (active flag: %s)",
  async (hasActiveRun) => {
    vi.useFakeTimers();
    const { client, controller } = setup();
    void controller.load(client, "current");
    await vi.advanceTimersByTimeAsync(0);
    controller.invalidate({
      key: active.key,
      agentId: active.agentId,
      sessionId: active.sessionId,
      runId: "retired-run",
      status: "done",
      hasActiveRun,
    });
    expect(controller.result?.sessions).toEqual([active]);
  },
);

it.each([
  { change: "active", pending: false },
  { change: "terminal", pending: false },
  { change: "delete", pending: false },
  { change: "active", pending: true },
  { change: "terminal", pending: true },
  { change: "delete", pending: true },
])(
  "refreshes a conflicting $change generation without confusing global owners (pending: $pending)",
  async ({ change, pending }) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    const globalRow = { ...active, key: "global", kind: "global" as const };
    const main = { ...globalRow, agentId: "main", sessionId: "main-global" };
    const work = { ...globalRow, agentId: "work", sessionId: "work-global" };
    const literal = { ...active, key: "agent:work:global", sessionId: "literal-global" };
    const replacement = {
      ...work,
      sessionId: "replacement-work-global",
      updatedAt: 201,
      snapshotAt: 201,
    };
    const authoritative =
      change === "active" ? [{ ...replacement, snapshotAt: 300 }, literal] : [literal];
    const initial = listing([main, work, literal]);
    request
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({ ...listing(authoritative), ts: 300 });
    await controller.load(client, "current");
    const stale = createDeferred<SessionsListResult>();
    if (pending) {
      request.mockReturnValueOnce(stale.promise);
      void controller.load(client, "current", "refresh");
    }
    controller.invalidate({
      ...main,
      updatedAt: 200,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    });
    controller.invalidate(
      change === "delete"
        ? {
            sessionKey: work.key,
            agentId: work.agentId,
            sessionId: replacement.sessionId,
            reason: "delete",
            ts: 201,
          }
        : {
            agentId: work.agentId,
            session:
              change === "active"
                ? replacement
                : {
                    ...replacement,
                    hasActiveRun: false,
                    activeRunIds: [],
                    status: "done",
                  },
            ancestorSessions: [],
          },
    );
    if (pending) {
      stale.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(controller.result?.sessions).toEqual([literal, work]);
    expect(controller.incomplete).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.result?.sessions).toEqual(authoritative);
    expect(controller.incomplete).toBe(false);
    expect(request).toHaveBeenCalledTimes(pending ? 3 : 2);
  },
);

it.each(["current", { personId: null, time: "all", query: "" }] as const)(
  "retains certified rows through a busy overlapping %j read without overflowing",
  async (query) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    await controller.load(client, query);
    const pending = createDeferred<SessionsListResult>();
    request.mockReturnValueOnce(pending.promise);
    void controller.load(client, query, "refresh");
    for (let revision = 1; revision <= 1_500; revision += 1) {
      controller.invalidate({
        agentId: active.agentId,
        reason: "patch",
        session: {
          ...active,
          updatedAt: 100 + revision,
          snapshotAt: 100 + revision,
          label: `Revision ${revision}`,
        },
        ancestorSessions: [],
      });
    }
    if (query === "current") {
      controller.invalidate({
        agentId: active.agentId,
        reason: "patch",
        session: { ...active, updatedAt: 1_600, snapshotAt: 1_599, label: "Delayed sample" },
        ancestorSessions: [],
      });
    }
    pending.resolve(listing([active]));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(controller.result?.sessions).toEqual([
      { ...active, updatedAt: 1_600, snapshotAt: 1_600, label: "Revision 1500" },
    ]);
    expect(controller.loading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it.each([
  { hasMore: false, limitApplied: 100, admit: true },
  { hasMore: true, limitApplied: 100, admit: false },
  { hasMore: false, limitApplied: 1, admit: false },
  { hasMore: false, limitApplied: 100, isDock: true, admit: false },
])(
  "admits certified active membership only into a complete window with space (%j)",
  async ({ hasMore, limitApplied, isDock = false, admit }) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    request.mockResolvedValue({ ...listing([active]), hasMore, limitApplied });
    await controller.load(client, "current");
    const added = {
      ...active,
      key: "agent:work:new",
      sessionId: "new-session",
      isDock,
      updatedAt: 200,
      snapshotAt: 200,
    };
    controller.invalidate({
      agentId: active.agentId,
      reason: "agent.run.started",
      session: added,
      ancestorSessions: [],
    });
    expect(controller.result?.sessions).toEqual(admit ? [added, active] : [active]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(admit || isDock ? 1 : 2);
  },
);

it.each([
  { heldChild: true, full: false, pending: false },
  { heldChild: true, full: false, pending: true },
  { heldChild: false, full: false, pending: false },
  { heldChild: false, full: false, pending: true },
  { heldChild: true, full: true, pending: false },
  { heldChild: true, full: true, pending: true },
])(
  "refreshes held parent facts after uncertified child completion (held: $heldChild, full: $full, pending: $pending)",
  async ({ heldChild, full, pending }) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
    const group = { groupId: "work", createdAt: 1, queued: 0, running: 1, done: 0, failed: 0 };
    const parent = {
      ...active,
      key: "agent:work:parent",
      sessionId: "parent-session",
      activeRunIds: ["parent-run"],
      hasActiveSubagentRun: true,
      swarm: { groups: [group], otherActiveGroups: 0 },
      ...(!heldChild ? { childSessions: [active.key] } : {}),
    };
    const child = { ...active, parentSessionKey: parent.key };
    const settledParent = {
      ...parent,
      updatedAt: 300,
      hasActiveSubagentRun: false,
      swarm: { groups: [{ ...group, running: 0, done: 1 }], otherActiveGroups: 0 },
    };
    const initial = listing(heldChild ? [child, parent] : [parent]);
    request
      .mockResolvedValueOnce(initial)
      .mockResolvedValue({ ...listing([settledParent]), ts: 300 });
    await controller.load(client, "current");
    const stale = createDeferred<SessionsListResult>();
    if (pending) {
      request.mockReturnValueOnce(stale.promise);
      void controller.load(client, "current", "refresh");
    }
    const completion = {
      key: child.key,
      sessionId: child.sessionId,
      agentId: child.agentId,
      updatedAt: 200,
      hasActiveRun: false,
      activeRunIds: [],
      status: "done",
    };
    controller.invalidate(
      full
        ? {
            agentId: child.agentId,
            session: { ...child, ...completion, snapshotAt: 200 },
            ancestorSessions: [],
          }
        : completion,
    );
    expect(controller.result?.sessions).toEqual([parent]);
    expect(controller.incomplete).toBe(true);
    if (pending) {
      stale.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.result?.sessions).toEqual([parent]);
      expect(controller.incomplete).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.result?.sessions).toEqual([settledParent]);
    expect(controller.incomplete).toBe(false);
    expect(request).toHaveBeenCalledTimes(pending ? 3 : 2);
  },
);

it.each([false, true])(
  "applies certified ancestor rows and references without refetching current work (pending: %s)",
  async (pending) => {
    vi.useFakeTimers();
    const { client, request, controller } = setup();
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
    request.mockResolvedValue(listing([child, parent, grandparent]));
    await controller.load(client, "current");
    const stale = createDeferred<SessionsListResult>();
    if (pending) {
      request.mockReturnValueOnce(stale.promise);
      void controller.load(client, "current", "refresh");
    }
    const updatedParent = {
      ...parent,
      label: "Parent after settlement",
      updatedAt: 150,
      snapshotAt: 200,
      status: "queued" as const,
      hasActiveSubagentRun: false,
    };
    controller.invalidate({
      agentId: active.agentId,
      reason: "subagent-status",
      session: { ...child, updatedAt: 200, snapshotAt: 200 },
      ancestorSessions: [
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
      ],
    });
    expect(controller.result?.sessions.find((row) => row.key === parent.key)).toEqual(
      updatedParent,
    );
    const reference = {
      key: parent.key,
      sessionId: parent.sessionId,
      revision: "parent-revision",
      snapshotAt: 300,
    };
    controller.invalidate({
      agentId: active.agentId,
      reason: "subagent-status",
      session: { ...child, updatedAt: 300, snapshotAt: 300 },
      ancestorSessions: [],
      ancestorSessionRefs: [
        reference,
        {
          key: grandparent.key,
          sessionId: grandparent.sessionId,
          revision: "grandparent-revision",
          snapshotAt: 300,
        },
        {
          key: "agent:work:inactive-ancestor",
          sessionId: "inactive-ancestor",
          revision: "inactive-ancestor-revision",
          snapshotAt: 300,
        },
      ],
    });
    controller.invalidate({
      agentId: active.agentId,
      reason: "subagent-status",
      session: { ...child, updatedAt: 250, snapshotAt: 250 },
      ancestorSessions: [
        {
          ...updatedParent,
          label: "Delayed parent snapshot",
          updatedAt: 175,
          snapshotAt: 250,
          ancestorRevision: "delayed-parent-revision",
        },
      ],
    });
    expect(controller.result?.sessions.find((row) => row.key === parent.key)).toEqual({
      ...updatedParent,
      snapshotAt: 300,
    });
    if (pending) {
      stale.resolve(listing([child, parent, grandparent]));
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(controller.result?.sessions.find((row) => row.key === parent.key)).toEqual({
      ...updatedParent,
      snapshotAt: 300,
    });
    expect(controller.result?.sessions).toHaveLength(3);
    expect(request).toHaveBeenCalledTimes(pending ? 2 : 1);
    controller.invalidate({
      agentId: active.agentId,
      session: { ...child, updatedAt: 301, snapshotAt: 301 },
      ancestorSessions: [],
      ancestorSessionRefs: [{ ...reference, sessionId: "retired-parent", snapshotAt: 301 }],
    });
    expect(controller.result?.sessions.find((row) => row.key === parent.key)?.sessionId).toBe(
      parent.sessionId,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledTimes(pending ? 3 : 2);
  },
);
