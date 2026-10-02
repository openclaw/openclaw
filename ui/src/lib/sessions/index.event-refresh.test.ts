// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const terminal = (session: GatewaySessionRow) => ({
  sessionKey: session.key,
  hasActiveRun: false,
  status: "done",
  session: { ...session, hasActiveRun: false, status: "done" },
});
const mainQuery = {
  agentId: "main",
  limit: 50,
  includeGlobal: true,
  includeUnknown: false,
  includeDerivedTitles: false,
  includeLastMessage: false,
  archivedFilter: "active" as const,
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
  return { ...fixture, firstList, secondList, secondListStarted };
}
function installPageLifecycle() {
  const documentEvents = new EventTarget();
  const pageEvents = new EventTarget();
  let visibilityState: DocumentVisibilityState = "visible";
  Object.defineProperty(documentEvents, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("addEventListener", pageEvents.addEventListener.bind(pageEvents));
  vi.stubGlobal("removeEventListener", pageEvents.removeEventListener.bind(pageEvents));
  return {
    setVisibility(next: DocumentVisibilityState) {
      visibilityState = next;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    pageHide: () => pageEvents.dispatchEvent(new Event("pagehide")),
    pageShow: () => pageEvents.dispatchEvent(new Event("pageshow")),
  };
}

describe("event-driven session list refresh", () => {
  it("does not admit an active message for a session absent from the canonical roster", async () => {
    const visibleKey = "agent:main:visible";
    const unrelatedKey = "agent:main:unrelated";
    const { sessions, message } = harness(() =>
      sessionsResult(
        [sessionRow(visibleKey, 1, { owner: { actor: { type: "human", id: "profile-self" } } })],
        1,
      ),
    );
    await sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([visibleKey]);
    message({
      sessionKey: unrelatedKey,
      key: unrelatedKey,
      kind: "direct",
      updatedAt: 2,
      archived: false,
      hasActiveRun: true,
      status: "running",
      owner: { actor: { type: "human", id: "profile-other" } },
      participants: [],
      participantCount: 0,
    });
    expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([visibleKey]);
  });

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
    const researchRequests = dashboardRequests();
    expect(researchRequests).toHaveLength(1);
    expect(researchRequests[0]?.[1]).toEqual({
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      limit: 4,
      includeDerivedTitles: true,
      includeLastMessage: true,
      archived: "all",
      hasBoard: true,
    });
    expect(researchRequests[0]?.[1]).not.toHaveProperty("offset");
    expect(researchRequests[0]?.[1]).not.toHaveProperty("agentId");
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

  it("refreshes a Sessions-style managed query after a terminal session message", async () => {
    const key = "agent:main:main";
    const calls = { canonical: 0, main: 0, research: 0 };
    const { sessions, request, message } = harness((params) => {
      const lane =
        params.includeUnknown === true
          ? "canonical"
          : params.agentId === "main"
            ? "main"
            : "research";
      calls[lane] += 1;
      const done = lane !== "research" && calls[lane] > 1;
      return sessionsResult(
        [
          sessionRow(lane === "research" ? "agent:research:other" : key, calls[lane], {
            hasActiveRun: !done,
            status: done ? "done" : "running",
          }),
        ],
        calls[lane],
      );
    });
    const researchQuery = { ...mainQuery, agentId: "research" };
    cleanup.push(
      sessions.subscribeList(mainQuery, () => {}),
      sessions.subscribeList(researchQuery, () => {}),
    );
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.refreshList({ ...mainQuery, force: true });
    await sessions.refreshList({ ...researchQuery, force: true });
    expect(sessions.listSnapshot(mainQuery).result?.sessions[0]).toMatchObject({
      hasActiveRun: true,
      status: "running",
    });
    request.mockClear();
    message(terminal(sessionRow(key, 2)));
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", includeUnknown: false }),
    );
    expect(calls).toEqual({ canonical: 1, main: 2, research: 1 });
    const done = { key, hasActiveRun: false, status: "done" };
    expect(sessions.state.result?.sessions[0]).toMatchObject(done);
    expect(sessions.listSnapshot(mainQuery).result?.sessions[0]).toMatchObject(done);
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
    expect(sessions.state.result?.sessions).toEqual([fallbackRow]);
  });

  it("refreshes the owner-filtered primary roster after a terminal session message", async () => {
    const key = "agent:main:main";
    let matchesFilteredRoster = true;
    const held = sessionRow(key, 1, {
      hasActiveRun: true,
      status: "running",
      label: "Ada",
      owner: { actor: { type: "human", id: "profile-ada", label: "Ada" } },
    });
    const { sessions, request, message } = harness((params) =>
      sessionsResult(
        params.ownerId && !matchesFilteredRoster ? [] : [held],
        matchesFilteredRoster ? 1 : 2,
      ),
    );
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.refresh({ agentId: "main", ownerId: "profile-ada", force: true });
    expect(sessions.state.result?.sessions.map((session) => session.key)).toEqual([key]);
    request.mockClear();
    matchesFilteredRoster = false;
    message(
      terminal({
        ...held,
        updatedAt: 2,
        label: "Bob",
        owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
      }),
    );
    expect(sessions.state.result?.sessions).toEqual([held]);
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ ownerId: "profile-ada" }),
    );
    expect(sessions.state.result?.sessions).toEqual([]);
  });

  it("retains every loaded page when a session event replaces the canonical list", async () => {
    const rows = Array.from({ length: 120 }, (_, index) =>
      sessionRow(`agent:main:session-${index}`, index + 1),
    );
    const { sessions, request, emitEvent } = harness((params) => pageResult(rows, params));
    await sessions.refresh({ agentId: "main", limit: 60, force: true });
    await sessions.refresh({ agentId: "main", limit: 60, offset: 60, append: true, force: true });
    expect(sessions.state.result?.sessions).toHaveLength(120);
    emitEvent(sessionChangedEvent("agent:main:session-0"));
    await tick();
    expect(request.mock.calls[2]?.[1]).toMatchObject({ agentId: "main", limit: 120 });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("offset");
    expect(sessions.state.result?.sessions).toHaveLength(120);
  });

  it("clears a recreated session's prior deletion before the debounced refresh", async () => {
    const key = "agent:main:recreated-thread";
    const { sessions, request, emitEvent } = harness(() => sessionsResult([], 1));
    await sessions.refresh({ force: true });
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: key, sessionId: "deleted-generation", reason: "delete" },
    });
    expect(sessions.state.deletedSessions).toEqual([
      { key, retireBeforeRevision: expect.any(Number) },
    ]);
    emitEvent(sessionChangedEvent(key));
    expect(sessions.state.deletedSessions).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves queued explicit options when the event debounce fires before the active request completes", async () => {
    const { sessions, request, emitEvent, firstList, secondList, secondListStarted } = heldReads();
    const initialRefresh = sessions.refresh({ agentId: "main", force: true });
    const explicitRefresh = sessions.refresh({
      agentId: "other",
      search: "queued",
      archivedFilter: "archived",
      limit: 17,
      includeDerivedTitles: true,
      backgroundHydrate: true,
      force: true,
    });
    emitEvent(sessionChangedEvent("agent:main:later-event"));
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    firstList.resolve(sessionsResult([], 1));
    await secondListStarted.promise;
    expect(request.mock.calls[1]?.[1]).toEqual({
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      limit: 17,
      includeDerivedTitles: true,
      archived: true,
      agentId: "other",
      search: "queued",
    });
    expect(sessions.state.loading).toBe(false);
    secondList.resolve(sessionsResult([], 2));
    await Promise.all([initialRefresh, explicitRefresh]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["before the append is queued", false, false, 3],
    ["before a queued foreground replacement", true, false, 2],
    ["before and during a queued foreground replacement", true, true, 3],
  ] as const)(
    "keeps event invalidation %s",
    async (_timing, queueForeground, eventDuringForeground, expectedCalls) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const { sessions, request, emitEvent, firstList, secondList, secondListStarted } =
        heldReads();
      const initialRefresh = sessions.refresh({ agentId: "main", limit: 25, force: true });
      emitEvent(sessionChangedEvent("agent:main:earlier-event"));
      const foregroundRefresh = queueForeground
        ? sessions.refresh({ agentId: "research", limit: 25, force: true })
        : Promise.resolve();
      const appendRefresh = sessions.refresh({
        agentId: "main",
        limit: 25,
        offset: 25,
        append: true,
        force: true,
      });
      await tick();
      firstList.resolve(sessionsResult([], 1));
      await secondListStarted.promise;
      const agentId = queueForeground ? "research" : "main";
      expect(request.mock.calls[1]?.[1]).toMatchObject({
        agentId,
        limit: 25,
        ...(queueForeground ? {} : { offset: 25 }),
      });
      if (eventDuringForeground) {
        emitEvent(sessionChangedEvent("agent:research:during-refresh"));
        await tick();
      }
      secondList.resolve(sessionsResult([], 2));
      await Promise.all([initialRefresh, foregroundRefresh, appendRefresh]);
      await tick();
      expect(request).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls === 3) {
        expect(request.mock.calls[2]?.[1]).toMatchObject({ agentId, limit: 25 });
        expect(request.mock.calls[2]?.[1]).not.toHaveProperty("offset");
      }
    },
  );

  it("holds canonical and filtered event refreshes while hidden and catches up once", async () => {
    const page = installPageLifecycle();
    const { sessions, request, emitEvent } = harness(() =>
      sessionsResult([sessionRow("agent:main:pending", 0)], 1),
    );
    cleanup.push(sessions.subscribeList({ agentId: "main", archivedFilter: "all" }, vi.fn()));
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.refreshList({ agentId: "main", archivedFilter: "all", force: true });
    emitEvent(sessionChangedEvent("agent:main:pending"));
    page.setVisibility("hidden");
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "agent:main:pending",
        reason: "update",
        key: "agent:main:pending",
        kind: "direct",
        updatedAt: 2,
        archived: true,
        archivedAt: 2,
      },
    });
    expect(sessions.state.result?.sessions).toEqual([]);
    await tick(10_000);
    expect(request).toHaveBeenCalledTimes(2);
    page.setVisibility("visible");
    page.pageShow();
    await tick(0);
    expect(request).toHaveBeenCalledTimes(4);
    page.setVisibility("hidden");
    page.pageHide();
    page.pageShow();
    await tick(0);
    expect(request).toHaveBeenCalledTimes(4);
    page.setVisibility("visible");
    await tick(4_999);
    expect(request).toHaveBeenCalledTimes(4);
    await tick(1);
    expect(request).toHaveBeenCalledTimes(6);
    sessions.dispose();
    await tick(10_000);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it.each(["success", "failure"])(
    "settles a roster refresh %s during an active message",
    async (outcome) => {
      const key = "agent:main:visible";
      const held = sessionRow(key, 1, { sessionId: "visible-generation" });
      const response = sessionsResult([{ ...held, label: "Refreshed", updatedAt: 3 }], 3);
      const pending = createDeferred<SessionsListResult>();
      let listCalls = 0;
      const { sessions, message } = harness(() =>
        ++listCalls === 1 ? sessionsResult([held], 1) : pending.promise,
      );
      cleanup.push(() => pending.resolve(response));
      await sessions.refresh({ agentId: "main", force: true });
      const refresh = sessions.refresh({ agentId: "main", force: true });
      expect(listCalls).toBe(2);
      expect(sessions.state.loading).toBe(true);
      message({
        sessionKey: key,
        key,
        kind: "direct",
        sessionId: held.sessionId,
        updatedAt: 2,
        archived: false,
        permissionMode: null,
        hasActiveRun: true,
        status: "running",
      });
      if (outcome === "success") {
        pending.resolve(response);
      } else {
        pending.reject(new Error("Roster refresh unavailable"));
      }
      await refresh;
      await vi.runAllTimersAsync();
      expect.soft(sessions.state.loading).toBe(false);
      expect.soft(listCalls).toBe(2);
      if (outcome === "success") {
        expect.soft(sessions.state.result?.sessions).toEqual(response.sessions);
        expect.soft(sessions.state.error).toBeNull();
      } else {
        expect.soft(sessions.state.error).toBe("Roster refresh unavailable");
      }
    },
  );

  it.each([false, true])(
    "publishes an active message into its existing Sessions page row (newer overlap: %s)",
    async (newerOverlap) => {
      const primary = sessionRow("agent:main:primary-a", 10, {
        sessionId: "primary-a-session",
        label: "Primary A",
      });
      const managed = sessionRow("agent:main:managed-b", 10, {
        sessionId: "managed-b-session",
        label: "Managed B",
        archived: false,
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
      });
      const primaryRows = newerOverlap ? [primary, { ...managed }] : [primary];
      if (newerOverlap) {
        managed.updatedAt = 30;
        managed.label = "Newer managed B";
      }
      const query = { ...mainQuery, search: managed.key, includeUnknown: true };
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
      const progress = (updatedAt: number, label: string, runId: string) => {
        const wire = JSON.stringify({
          sessionKey: managed.key,
          agentId: "main",
          runId,
          messageId: `message-${runId}`,
          messageSeq: updatedAt,
          message: { role: "assistant", content: [{ type: "text", text: "Synthetic progress" }] },
          status: "running",
          hasActiveRun: true,
          session: {
            ...managed,
            updatedAt,
            label,
            status: "running",
            hasActiveRun: true,
            activeRunIds: [runId],
            startedAt: updatedAt,
            permissionMode: null,
          },
        });
        const payload: unknown = JSON.parse(wire);
        message(payload);
      };
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList(query);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.state.result?.sessions).toEqual(
        newerOverlap ? [primary, managed] : [primary],
      );
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
            status: "running",
            hasActiveRun: true,
            activeRunIds: ["current-run"],
          };
      const snapshot = sessions.listSnapshot(query);
      expect.soft(snapshot.result?.sessions[0]).toMatchObject(expected);
      if (newerOverlap) {
        expect(observed).toEqual([]);
        expect
          .soft(sessions.state.result?.sessions.find((row) => row.key === managed.key))
          .toEqual(managed);
        expect(sessions.state.result?.sessions.find((row) => row.key === primary.key)).toEqual(
          primary,
        );
        expect(sessions.state.result?.sessions.map((row) => row.key).toSorted()).toEqual(
          primaryRows.map((row) => row.key).toSorted(),
        );
      } else {
        expect.soft(observed.at(-1)).toMatchObject(expected);
        expect(sessions.state.result).toBe(initialPrimary);
        expect(sessions.state.result?.sessions).toEqual([primary]);
      }
      expect(snapshot.result?.sessions.map((row) => row.key)).toEqual([managed.key]);
      expect(snapshot.result).toMatchObject({
        count: 1,
        totalCount: 1,
        hasMore: false,
        nextOffset: null,
      });
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
    const { sessions, request, emitEvent } = harness(() => sessionsResult([researchRow], 1));
    await sessions.refresh({ agentId: "main", force: true });
    const before = sessions.state.result;
    request.mockClear();
    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: "global",
        reason: "updated",
        updatedAt: 2,
        owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
        model: "ops-model",
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["ops-run"],
      },
    });
    expect(sessions.state.result).toBe(before);
    await tick();
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main" }),
    );
    expect(sessions.state.result?.sessions).toEqual([researchRow]);
  });
});
