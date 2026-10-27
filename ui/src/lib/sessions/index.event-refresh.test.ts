// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionChangedEvent,
  sessionsResult,
} from "./session-capability.test-support.ts";

const cleanup: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const tick = (ms = 5_000) => vi.advanceTimersByTimeAsync(ms);
const sessionRow = (
  key: string,
  updatedAt: number,
  extra: Partial<GatewaySessionRow> = {},
): GatewaySessionRow => ({
  key,
  kind: "direct",
  updatedAt,
  ...extra,
});
const active = { hasActiveRun: true, status: "running" as const };
const completed = { hasActiveRun: false, status: "done" as const };
const terminal = (session: GatewaySessionRow) => ({
  sessionKey: session.key,
  ...completed,
  session: { ...session, ...completed },
});
const requestDefaults = {
  excludeDock: true,
  includeGlobal: true,
  includeUnknown: true,
  configuredAgentsOnly: true,
};
function pageResult(rows: GatewaySessionRow[], params: Record<string, unknown>, ts?: number) {
  const offset = typeof params.offset === "number" ? params.offset : 0;
  const limit = typeof params.limit === "number" ? params.limit : 50;
  const page = rows.slice(offset, offset + limit);
  const hasMore = offset + page.length < rows.length;
  return {
    ...sessionsResult(page, ts ?? offset + 1),
    totalCount: rows.length,
    hasMore,
    nextOffset: hasMore ? offset + page.length : null,
  };
}
function harness(
  read: (params: Record<string, unknown>) => SessionsListResult | Promise<SessionsListResult>,
) {
  const request = createGatewayRequestMock((method, params) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return read(asOptionalRecord(params) ?? {});
  });
  const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(gateway);
  cleanup.push(sessions.dispose);
  return {
    sessions,
    request,
    emitEvent,
    refresh: (options: Parameters<typeof sessions.refresh>[0] = {}) =>
      sessions.refresh({ agentId: "main", force: true, ...options }),
    rows: (expected: GatewaySessionRow[]) =>
      expect(sessions.state.result?.sessions).toEqual(expected),
    calls: (count: number) => expect(request).toHaveBeenCalledTimes(count),
    afterTick: async (count: number, ms = 5_000) => {
      await tick(ms);
      expect(request).toHaveBeenCalledTimes(count);
    },
    change: (payload: unknown) => emitEvent({ type: "event", event: "sessions.changed", payload }),
    message: (payload: unknown) => emitEvent({ type: "event", event: "session.message", payload }),
  };
}
function heldReads() {
  const firstList = createDeferred<SessionsListResult>();
  const secondList = createDeferred<SessionsListResult>();
  const secondListStarted = createDeferred();
  let calls = 0;
  const fixture = harness(() => {
    if (++calls === 1) {
      return firstList.promise;
    }
    if (calls === 2) {
      secondListStarted.resolve();
      return secondList.promise;
    }
    return sessionsResult([], calls);
  });
  cleanup.push(() => {
    firstList.resolve(sessionsResult([], 1));
    secondList.resolve(sessionsResult([], 2));
  });
  return {
    ...fixture,
    firstList,
    secondList,
    advanceRead: async () => {
      firstList.resolve(sessionsResult([], 1));
      await secondListStarted.promise;
    },
  };
}
function installPageLifecycle() {
  const documentEvents = Object.assign(new EventTarget(), {
    documentElement: { getAttribute: () => null },
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const pageEvents = new EventTarget();
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  return {
    setVisibility(next: DocumentVisibilityState) {
      documentEvents.visibilityState = next;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    pageHide: () => pageEvents.dispatchEvent(new Event("pagehide")),
    pageShow: () => pageEvents.dispatchEvent(new Event("pageshow")),
  };
}

it("refreshes exact managed queries by agent and retains appended dashboard windows", async () => {
  const dashboardRows = Array.from({ length: 4 }, (_, index) =>
    sessionRow(`agent:main:dashboard-${index}`, index + 1, { boardFace: "dashboard" }),
  );
  const { sessions, request, emitEvent } = harness((params) => {
    if (params.hasBoard !== true) {
      return sessionsResult([], 1);
    }
    const agentId = params.agentId;
    if (agentId !== undefined && typeof agentId !== "string") {
      throw new Error("Unexpected dashboard agent ID");
    }
    const rows = agentId
      ? [{ ...dashboardRows[0]!, key: `agent:${agentId}:dashboard` }]
      : dashboardRows;
    return pageResult(rows, params, 1);
  });
  const allAgentsQuery = {
    hasBoard: true,
    archivedFilter: "all" as const,
    includeDerivedTitles: true,
    includeLastMessage: true,
    limit: 2,
  };
  const writerQuery = { ...allAgentsQuery, agentId: "writer" };
  cleanup.push(
    sessions.subscribeList(allAgentsQuery, () => {}),
    sessions.subscribeList(writerQuery, () => {}),
  );
  await sessions.refresh({ agentId: "writer", force: true });
  await sessions.refreshList({ ...allAgentsQuery, force: true });
  await sessions.refreshList({ ...allAgentsQuery, offset: 2, append: true, force: true });
  await sessions.refreshList({ ...writerQuery, force: true });
  expect(sessions.listSnapshot(allAgentsQuery).result?.sessions).toHaveLength(4);
  request.mockClear();
  emitEvent(sessionChangedEvent("agent:research:changed"));
  await tick();
  expect(request).toHaveBeenCalledTimes(1);
  const dashboardRequests = () =>
    request.mock.calls.filter(([, params]) => asOptionalRecord(params)?.hasBoard === true);
  expect(dashboardRequests()[0]?.[1]).toEqual({
    ...requestDefaults,
    rowMode: "compact",
    source: "chat-pane",
    ifRowsRevision: "",
    limit: 4,
    includeDerivedTitles: true,
    includeLastMessage: true,
    archived: "all",
    hasBoard: true,
  });
  expect(sessions.listSnapshot(allAgentsQuery).result?.sessions).toHaveLength(4);
  request.mockClear();
  emitEvent(sessionChangedEvent("agent:writer:changed"));
  await tick();
  expect(request).toHaveBeenCalledTimes(3);
  const writerRequests = dashboardRequests();
  expect(writerRequests).toHaveLength(2);
  expect(writerRequests.map(([, params]) => asOptionalRecord(params)?.agentId ?? null)).toEqual(
    expect.arrayContaining(["writer", null]),
  );
});

it("keeps an archived terminal session until the Gateway replaces the active roster", async () => {
  const mainRow = sessionRow("agent:main:main", 1);
  const fallbackRow = sessionRow("agent:main:fallback", 2);
  let listCalls = 0;
  const { sessions, request, message } = harness(() =>
    sessionsResult(++listCalls === 1 ? [mainRow] : [fallbackRow], listCalls),
  );
  await sessions.refresh({ force: true });
  request.mockClear();
  const visibleRosters: SessionsListResult["sessions"][] = [];
  let previousRoster = sessions.state.result?.sessions;
  cleanup.push(
    sessions.subscribe((next) => {
      if (next.result?.sessions !== previousRoster) {
        previousRoster = next.result?.sessions;
        visibleRosters.push(next.result?.sessions ?? []);
      }
    }),
  );
  message(terminal({ ...mainRow, updatedAt: 3, archived: true }));
  expect(sessions.state.result?.sessions).toEqual([mainRow]);
  expect(visibleRosters).toEqual([]);
  await tick();
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "sessions.list",
    expect.objectContaining({ configuredAgentsOnly: true }),
  );
  expect(visibleRosters).toEqual([[fallbackRow]]);
});

it("rereads owner-filtered rows only when ownership changes", async () => {
  const key = "agent:main:main";
  let matchesFilteredRoster = true;
  const initial = sessionRow(key, 1, {
    sessionId: "owned-session",
    ...active,
    label: "Ada",
    owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
  });
  let held = initial;
  const { sessions, request, message, change, refresh, rows } = harness((params) =>
    sessionsResult(
      params.ownerId && !matchesFilteredRoster ? [] : [held],
      matchesFilteredRoster ? 1 : 2,
    ),
  );
  await refresh();
  await refresh({ ownerId: "profile-ada" });
  expect(sessions.state.result?.sessions.map((session) => session.key)).toEqual([key]);
  request.mockClear();
  for (let second = 0; second < 60; second++) {
    held = { ...initial, updatedAt: second + 2, totalTokens: second + 1 };
    change({ reason: "patch", sessionKey: key, session: held, ancestorSessions: [] });
    await tick(1_000);
  }
  expect(request).not.toHaveBeenCalled();
  rows([held]);
  matchesFilteredRoster = false;
  message(
    terminal({
      ...held,
      updatedAt: 62,
      label: "Bob",
      owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
    }),
  );
  rows([held]);
  await tick();
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "sessions.list",
    expect.objectContaining({ ownerId: "profile-ada" }),
  );
  rows([]);
});

it.each([false, true])(
  "absorbs an older fallback at an authoritative read but retains later invalidation (%s)",
  async (invalidateDuringRead) => {
    let held = sessionRow("agent:main:held", 1, { sessionId: "held" });
    const pending = createDeferred<SessionsListResult>();
    let reads = 0;
    const { rows, refresh, afterTick, change } = harness(() =>
      ++reads === 2 ? pending.promise : sessionsResult([held], reads),
    );
    await refresh();
    held = { ...held, updatedAt: 2, label: "Updated" };
    change({ reason: "patch", session: held, ancestorSessions: [] });
    await afterTick(1, 10_000);
    const invalidate = () => change({ reason: "stores" });
    invalidate();
    await afterTick(2);
    if (invalidateDuringRead) {
      invalidate();
    }
    pending.resolve(sessionsResult([held], 2));
    await afterTick(invalidateDuringRead ? 3 : 2, 70_000);
    rows([held]);
  },
);

it("retains every loaded page when a session event replaces the canonical list", async () => {
  const rows = Array.from({ length: 120 }, (_, index) =>
    sessionRow(`agent:main:session-${index}`, index + 1),
  );
  const { sessions, request, emitEvent, refresh } = harness((params) => pageResult(rows, params));
  await refresh({ limit: 60 });
  await refresh({ limit: 60, offset: 60, append: true });
  expect(sessions.state.result?.sessions).toHaveLength(120);
  emitEvent(sessionChangedEvent("agent:main:session-0"));
  await tick();
  expect(request.mock.calls[2]?.[1]).toMatchObject({ agentId: "main", limit: 120 });
  expect(request.mock.calls[2]?.[1]).not.toHaveProperty("offset");
  expect(sessions.state.result?.sessions).toHaveLength(120);
});

it("clears a recreated session's prior deletion before the debounced refresh", async () => {
  const key = "agent:main:recreated-thread";
  const { sessions, change, emitEvent, calls, afterTick } = harness(() => sessionsResult([], 1));
  await sessions.refresh({ force: true });
  change({ sessionKey: key, sessionId: "deleted-generation", reason: "delete" });
  expect(sessions.state.deletedSessions).toEqual([
    { key, retireBeforeRevision: expect.any(Number) },
  ]);
  emitEvent(sessionChangedEvent(key));
  expect(sessions.state.deletedSessions).toEqual([]);
  calls(1);
  await afterTick(2);
});

it("batches remote session creation across primary and observed lists without postponing membership", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const rows: GatewaySessionRow[] = [];
  const { sessions, request, change, refresh } = harness((params) =>
    pageResult(rows, params, Date.now()),
  );
  const query = { ownerId: "viewer", limit: 100 };
  cleanup.push(sessions.subscribeList(query, () => {}));
  await refresh({ limit: 100 });
  await sessions.refreshList(query);
  request.mockClear();

  for (let second = 0; second < 60; second++) {
    const row = sessionRow(`agent:main:created-${second}`, Date.now(), {
      sessionId: `created-${second}`,
    });
    rows.unshift(row);
    change({ reason: "create", sessionKey: row.key, session: row });
    await tick(1_000);
    if (second % 5 === 4) {
      expect(sessions.listSnapshot(query).result?.sessions.map((entry) => entry.key)).toEqual(
        rows.map((entry) => entry.key),
      );
    }
  }

  expect(request.mock.calls.filter(([, params]) => asOptionalRecord(params)?.ownerId)).toHaveLength(
    12,
  );
  expect(
    request.mock.calls.filter(([, params]) => !asOptionalRecord(params)?.ownerId),
  ).toHaveLength(12);
  expect(sessions.state.result?.sessions).toEqual(rows);
  await tick(20_000);
  expect(request).toHaveBeenCalledTimes(24);
});

it("preserves queued explicit options across the active request's event debounce", async () => {
  const f = heldReads();
  const initialRefresh = f.refresh();
  const explicitRefresh = f.refresh({
    agentId: "other",
    search: "queued",
    archivedFilter: "archived",
    limit: 17,
    includeDerivedTitles: true,
    backgroundHydrate: true,
  });
  f.emitEvent(sessionChangedEvent("agent:main:later-event"));
  await f.afterTick(1);
  await f.advanceRead();
  expect(f.request.mock.calls[1]?.[1]).toEqual({
    ...requestDefaults,
    rowMode: "sidebar",
    source: "sidebar",
    limit: 17,
    includeDerivedTitles: true,
    archived: true,
    agentId: "other",
    search: "queued",
  });
  expect(f.sessions.state.loading).toBe(false);
  f.secondList.resolve(sessionsResult([], 2));
  await Promise.all([initialRefresh, explicitRefresh]);
  f.calls(2);
});

it.each([
  ["before the append is queued", false, false, 3],
  ["before a queued foreground replacement", true, false, 2],
  ["before and during a queued foreground replacement", true, true, 3],
] as const)(
  "keeps event invalidation %s",
  async (_timing, queueForeground, eventDuringForeground, expectedCalls) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const f = heldReads();
    const initialRefresh = f.refresh({ limit: 25 });
    f.emitEvent(sessionChangedEvent("agent:main:earlier-event"));
    const foregroundRefresh = queueForeground
      ? f.refresh({ agentId: "research", limit: 25 })
      : Promise.resolve();
    const appendRefresh = f.refresh({ limit: 25, offset: 25, append: true });
    await tick();
    await f.advanceRead();
    const agentId = queueForeground ? "research" : "main";
    expect(f.request.mock.calls[1]?.[1]).toMatchObject({
      agentId,
      limit: 25,
      ...(queueForeground ? {} : { offset: 25 }),
    });
    if (eventDuringForeground) {
      f.emitEvent(sessionChangedEvent("agent:research:during-refresh"));
      await tick();
    }
    f.secondList.resolve(sessionsResult([], 2));
    await Promise.all([initialRefresh, foregroundRefresh, appendRefresh]);
    await f.afterTick(expectedCalls);
    if (expectedCalls === 3) {
      expect(f.request.mock.calls[2]?.[1]).toMatchObject({ agentId, limit: 25 });
      expect(f.request.mock.calls[2]?.[1]).not.toHaveProperty("offset");
    }
  },
);

it("holds canonical and filtered event refreshes while hidden and catches up once", async () => {
  const page = installPageLifecycle();
  const { sessions, change, refresh, afterTick, emitEvent, rows } = harness(() =>
    sessionsResult([sessionRow("agent:main:pending", 0)], 1),
  );
  cleanup.push(sessions.subscribeList({ agentId: "main", archivedFilter: "all" }, vi.fn()));
  await refresh();
  await sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
  emitEvent(sessionChangedEvent("agent:main:pending"));
  page.setVisibility("hidden");
  change({
    sessionKey: "agent:main:pending",
    reason: "update",
    key: "agent:main:pending",
    kind: "direct",
    updatedAt: 2,
    archived: true,
    archivedAt: 2,
  });
  rows([]);
  await afterTick(2, 10_000);
  page.setVisibility("visible");
  page.pageShow();
  await afterTick(4, 0);
  page.setVisibility("hidden");
  page.pageHide();
  page.pageShow();
  await afterTick(4, 0);
  page.setVisibility("visible");
  await afterTick(4, 4_999);
  await afterTick(6, 1);
  sessions.dispose();
  await afterTick(6, 10_000);
});

it.each(["success", "failure"])(
  "settles a roster refresh %s during an active message",
  async (outcome) => {
    const key = "agent:main:visible";
    const held = sessionRow(key, 1, { sessionId: "visible-generation" });
    const response = sessionsResult([{ ...held, label: "Refreshed", updatedAt: 3 }], 3);
    const pending = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const { sessions, message, refresh } = harness(() =>
      ++listCalls === 1 ? sessionsResult([held], 1) : pending.promise,
    );
    cleanup.push(() => pending.resolve(response));
    await refresh();
    const pendingRefresh = refresh();
    expect([listCalls, sessions.state.loading]).toEqual([2, true]);
    message({
      sessionKey: key,
      key,
      kind: "direct",
      sessionId: held.sessionId,
      updatedAt: 2,
      archived: false,
      permissionMode: null,
      ...active,
    });
    if (outcome === "success") {
      pending.resolve(response);
    } else {
      pending.reject(new Error("Roster refresh unavailable"));
    }
    await pendingRefresh;
    await vi.runAllTimersAsync();
    expect.soft([listCalls, sessions.state.loading]).toEqual([2, false]);
    if (outcome === "success") {
      expect
        .soft([sessions.state.result?.sessions, sessions.state.error])
        .toEqual([response.sessions, null]);
    } else {
      expect.soft(sessions.state.error).toBe("Roster refresh unavailable");
    }
  },
);

it.each([false, true])(
  "publishes an active message into its existing Sessions page row (newer overlap: %s)",
  async (newerOverlap) => {
    const labeledRow = (name: string, label: string, extra: Partial<GatewaySessionRow> = {}) =>
      sessionRow(`agent:main:${name}`, 10, { sessionId: `${name}-session`, label, ...extra });
    const primary = labeledRow("primary-a", "Primary A");
    const managed = labeledRow("managed-b", "Managed B", {
      archived: false,
      ...completed,
      activeRunIds: [],
    });
    const primaryRows = newerOverlap ? [primary, { ...managed }] : [primary];
    if (newerOverlap) {
      managed.updatedAt = 30;
      managed.label = "Newer managed B";
    }
    const query = {
      agentId: "main",
      limit: 50,
      search: managed.key,
      archivedFilter: "active" as const,
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
    };
    const { sessions, request, message } = harness(({ search }) => {
      if (search !== undefined && search !== managed.key) {
        throw new Error("Unexpected Sessions page search");
      }
      return {
        ...sessionsResult(search === managed.key ? [managed] : primaryRows, 10),
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      };
    });
    const observed: Array<GatewaySessionRow | undefined> = [];
    cleanup.push(
      sessions.subscribeList(query, (snapshot) => {
        observed.push(snapshot.result?.sessions.find((row) => row.key === managed.key));
      }),
    );
    const progress = (updatedAt: number, label: string, runId: string) =>
      message({
        sessionKey: managed.key,
        ...active,
        session: {
          ...managed,
          updatedAt,
          label,
          ...active,
          activeRunIds: [runId],
          startedAt: updatedAt,
          permissionMode: null,
        },
      });
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.refreshList(query);
    expect(request).toHaveBeenCalledTimes(2);
    expect(sessions.state.result?.sessions).toEqual(newerOverlap ? [primary, managed] : [primary]);
    expect(sessions.listSnapshot(query).result?.sessions).toEqual([managed]);
    const initialPrimary = sessions.state.result;
    progress(5, "Older B", "older-run");
    expect(sessions.listSnapshot(query).result?.sessions).toEqual([managed]);
    expect(observed.at(-1)).toEqual(managed);
    observed.length = 0;
    progress(20, "Current B", "current-run");
    const expected = newerOverlap
      ? managed
      : {
          key: managed.key,
          sessionId: managed.sessionId,
          label: "Current B",
          updatedAt: 20,
          ...active,
          activeRunIds: ["current-run"],
        };
    const snapshot = sessions.listSnapshot(query);
    expect.soft(snapshot.result).toMatchObject({
      sessions: [expected],
      count: 1,
      totalCount: 1,
      hasMore: false,
      nextOffset: null,
    });
    if (newerOverlap) {
      expect(observed).toEqual([]);
      expect.soft(sessions.state.result?.sessions).toHaveLength(2);
      expect
        .soft(sessions.state.result?.sessions)
        .toEqual(expect.arrayContaining([primary, managed]));
    } else {
      expect.soft(observed.at(-1)).toMatchObject(expected);
      expect(sessions.state.result).toBe(initialPrimary);
      expect(sessions.state.result?.sessions).toEqual([primary]);
    }
    expect(request).toHaveBeenCalledTimes(2);
  },
);
it("refreshes the canonical roster without merging an ownerless raw-global snapshot", async () => {
  const researchRow = {
    key: "global",
    kind: "global" as const,
    updatedAt: 1,
    owner: { actor: { type: "agent" as const, id: "research", label: "Research" } },
    model: "research-model",
    status: "done" as const,
  };
  const { sessions, request, change } = harness(() => sessionsResult([researchRow], 1));
  await sessions.refresh({ agentId: "main", force: true });
  const before = sessions.state.result;
  request.mockClear();
  change({
    sessionKey: "global",
    reason: "updated",
    updatedAt: 2,
    owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
    model: "ops-model",
    ...active,
    activeRunIds: ["ops-run"],
  });
  expect(sessions.state.result).toBe(before);
  await tick();
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "sessions.list",
    expect.objectContaining({ agentId: "main" }),
  );
  expect(sessions.state.result?.sessions).toEqual([researchRow]);
});
