// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import {
  advance,
  coordinated,
  ownRoster,
  listRequest,
  queuedLists,
  rosterFixture,
} from "./session-roster-refresh.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");

function changed(payload: Record<string, unknown>) {
  return { type: "event" as const, event: "sessions.changed", payload };
}

function message(payload: Record<string, unknown>) {
  return { type: "event" as const, event: "session.message", payload };
}

function resultFor(agentId: string, ts: number) {
  return sessionsResult([{ key: `agent:${agentId}:main`, kind: "direct", updatedAt: ts }], ts);
}

describe("session roster refresh", () => {
  it("reuses conditional sidebar rows while accepting fresh facets and query replacements", async () => {
    const row = {
      key: "agent:main:one",
      sessionId: "one",
      label: "Original",
      kind: "direct" as const,
    };
    const request = vi
      .fn()
      .mockResolvedValue({ ...sessionsResult([row], 1), rowsRevision: "first" });
    const { sessions, watch, listResult } = rosterFixture(request);
    const query = { agentId: "main", rowMode: "sidebar" as const, archivedFilter: "all" as const };
    watch(query);
    await sessions.refreshList({ ...query, force: true });
    request.mockResolvedValue({
      ...sessionsResult([], 2),
      count: 1,
      rowsRevision: "first",
      rowsUnchanged: true,
      totalCount: 17,
      owners: [{ actor: { type: "human", id: "owner" }, label: "Fresh facet" }],
    });
    await sessions.refreshList({ ...query, force: true });
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ ifRowsRevision: "delta:first" }),
    );
    expect(listResult(query)).toMatchObject({
      sessions: [row],
      count: 1,
      totalCount: 17,
      owners: [{ actor: { type: "human", id: "owner" }, label: "Fresh facet" }],
    });
    request.mockResolvedValue({
      ...sessionsResult([{ ...row, label: "Renamed" }], 3),
      rowsRevision: "next",
    });
    await sessions.refreshList({ ...query, force: true });
    expect(listResult(query)?.sessions[0]?.label).toBe("Renamed");
    request.mockResolvedValue({ ...sessionsResult([], 2), rowsRevision: "empty" });
    await sessions.refreshList({ ...query, ownerId: "different", force: true });
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("ifRowsRevision");
  });

  it.each(["primary", "managed"] as const)(
    "keeps the %s startup retry alive past three minutes and cancels it on disposal",
    async (owner) => {
      vi.useFakeTimers();
      const pending = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Agent is preparing its database",
        retryable: true,
        retryAfterMs: 7_000,
        details: { code: "agent-database-inspection-pending", agentId: "main" },
      });
      const request = vi.fn().mockRejectedValue(pending);
      const { sessions, watch } = rosterFixture(request);
      const query = {
        agentId: "main",
        ...(owner === "managed" ? { archivedFilter: "all" as const } : {}),
      };
      const stop = watch(query);
      await sessions.refreshList({ ...query, force: true });
      expect(sessions.listSnapshot(query)).toMatchObject({ startupPending: true, error: null });
      await advance(6_999);
      expect(request).toHaveBeenCalledOnce();
      await advance(1);
      expect(request).toHaveBeenCalledTimes(2);
      await advance(180_000);
      const reads = request.mock.calls.length;
      expect(reads).toBeGreaterThan(20);
      expect(sessions.listSnapshot(query)).toMatchObject({ startupPending: true, error: null });
      stop();
      sessions.dispose();
      await advance(30_000);
      expect(request).toHaveBeenCalledTimes(reads);
    },
  );

  it.each([
    { recover: false, explicit: false },
    { recover: true, explicit: false },
    { recover: true, explicit: true },
  ])(
    "re-admits automatic hydration behind an explicit read (observer recovery: $recover, explicit replacement: $explicit)",
    async ({ recover, explicit: replaceDuringHold }) => {
      vi.useFakeTimers();
      const initial = createDeferred<SessionsListResult>();
      let reads = 0;
      let subscriptions = 0;
      const { publish, hold, release, sessions, resolveOnCleanup, settle } = coordinated(
        async (method) => {
          if (method === "sessions.subscribe") {
            if (++subscriptions === 1 && recover) {
              throw new GatewayRequestError({
                code: "UNAVAILABLE",
                message: "observer unavailable",
                retryable: true,
                retryAfterMs: 100,
              });
            }
            return { subscribed: true };
          }
          if (method !== "sessions.list") {
            throw new Error(`Unexpected request: ${method}`);
          }
          return ++reads === 1 ? initial.promise : sessionsResult([], reads);
        },
      );
      const explicit = sessions.refresh({ agentId: "main", force: true });
      resolveOnCleanup([initial, sessionsResult([], 1)]);
      settle(() => explicit);
      publish(true);
      await advance(100);
      expect(reads).toBe(1);
      expect(subscriptions).toBe(recover ? 2 : 1);
      hold("agent:main:next-chat");
      initial.resolve(sessionsResult([], 1));
      await advance();
      expect(reads).toBe(1);
      if (replaceDuringHold) {
        await sessions.refresh({ agentId: "main", force: true, backgroundHydrate: true });
        expect(reads).toBe(2);
      }
      release("agent:main:next-chat");
      await advance();
      expect(reads).toBe(2);
      expect(sessions.state.result?.ts).toBe(2);
    },
  );

  it.each([
    { owner: "primary", timing: "the pending RPC" },
    { owner: "managed", timing: "the pending RPC" },
    { owner: "primary", timing: "response publication" },
    { owner: "managed", timing: "response publication" },
    { owner: "managed", timing: "the pending RPC", explicit: "pending" },
    { owner: "managed", timing: "the pending RPC", explicit: "held" },
    { owner: "managed", timing: "the pending RPC", explicit: "readmission" },
  ])(
    "retains invalidation during $timing for the $owner roster (explicit: $explicit)",
    async ({ owner, timing, explicit }) => {
      vi.useFakeTimers();
      const managed = owner === "managed";
      const agentId = managed ? "worker" : "main";
      const key = `agent:${agentId}:tracked`;
      const parentKey = "agent:main:parent";
      const query = { agentId, ...(managed ? { spawnedBy: parentKey } : {}) };
      const result = (revision: number) =>
        sessionsResult(
          [{ key, kind: "direct", label: `Revision ${revision}`, updatedAt: revision }],
          revision,
        );
      const slow = createDeferred<SessionsListResult>();
      let reads = 0;
      const request = listRequest((params) => {
        const paramsRecord = requireRecord(params, "sessions.list params");
        if (paramsRecord.agentId !== agentId || (managed && paramsRecord.spawnedBy !== parentKey)) {
          return sessionsResult([], 0);
        }
        reads += 1;
        return reads === 2 ? slow.promise : result(reads);
      });
      const { emitEvent, hold, release, sessions, resolveOnCleanup, watch } = coordinated(request);
      const invalidate = () =>
        emitEvent(
          changed({ sessionKey: key, key, agentId, reason: "patch", spawnedBy: parentKey }),
        );
      let current: SessionsListResult | null = null;
      let invalidatedDuringPublication = false;
      const observe = (next: { result: SessionsListResult | null }) => {
        current = next.result;
        if (
          timing === "response publication" &&
          next.result?.ts === 2 &&
          !invalidatedDuringPublication
        ) {
          invalidatedDuringPublication = true;
          invalidate();
        }
      };
      const subscription = managed ? sessions.observeList(query, observe) : null;
      const stop = subscription ? () => subscription.dispose() : sessions.subscribe(observe);
      resolveOnCleanup([slow, result(2)]);
      watch(stop);
      await (subscription ? subscription.refresh() : sessions.refresh(query));
      expect(reads).toBe(1);
      if (explicit === "readmission") {
        hold("agent:main:first-chat");
      }
      invalidate();
      await advance(5_000);
      const delayedExplicit = explicit === "readmission" ? subscription?.refresh() : null;
      expect(reads).toBe(2);
      if (explicit === "readmission") {
        release("agent:main:first-chat");
        await advance();
      } else if (timing === "the pending RPC") {
        invalidate();
        await advance(200);
        expect(reads).toBe(2);
      }
      const nextChatHoldsRefresh = timing === "the pending RPC";
      if (nextChatHoldsRefresh) {
        hold("agent:main:next-chat");
      }
      const explicitRefresh = explicit === "pending" ? subscription?.refresh() : null;
      slow.resolve(result(2));
      await advance(5_000);
      if (nextChatHoldsRefresh) {
        expect(reads).toBe(explicit === "pending" ? 3 : 2);
        if (explicit === "held") {
          await subscription?.refresh();
          expect(reads).toBe(3);
        }
        release("agent:main:next-chat");
        await advance();
      }
      await explicitRefresh;
      await delayedExplicit;
      // An explicit read subsumes an event still waiting for background admission.
      const revision = explicit === "readmission" ? 2 : 3;
      expect(reads).toBe(revision);
      expect(current).toMatchObject({
        ts: revision,
        sessions: [{ key, label: `Revision ${revision}` }],
      });
    },
  );

  it.each(["All", "primary"] as const)(
    "uses a newer search observation when an older %s query completes",
    async (owner) => {
      const managed = owner === "All";
      const archivedKey = "agent:main:archived-overlap";
      const primaryRow = {
        key: "agent:main:primary-only",
        agentId: "main",
        sessionId: "primary-only-session",
        kind: "direct" as const,
        archived: false,
        updatedAt: 1,
      };
      const oldRow = {
        key: archivedKey,
        agentId: "main",
        sessionId: "archived-overlap-session",
        kind: "direct" as const,
        archived: managed,
        ...(managed ? { archivedAt: 5 } : {}),
        updatedAt: 10,
        label: "Earlier archived label",
      };
      const newerRow = { ...oldRow, updatedAt: 20, label: "Newer archived label" };
      const latestRow = { ...oldRow, updatedAt: 30, label: "Latest All-query label" };
      const completingQuery = {
        agentId: "main",
        archivedFilter: managed ? "all" : "active",
        includeDerivedTitles: true,
        includeLastMessage: true,
      } as const;
      const searchQuery = {
        ...completingQuery,
        archivedFilter: "all" as const,
        search: archivedKey,
        limit: 50,
        includeDerivedTitles: false,
        includeLastMessage: false,
      };
      const oldAll = {
        ...sessionsResult([{ ...oldRow }, { ...primaryRow }], 10),
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
      };
      const delayed = createDeferred<typeof oldAll>();
      const allDispatched = createDeferred();
      let holdAll = true;
      let initialPrimary = true;
      const unexpectedMethods: string[] = [];
      const client = createTestGatewayClient(async (method, params) => {
        if (method !== "sessions.list") {
          unexpectedMethods.push(method);
          throw new Error(`Unexpected Gateway method: ${method}`);
        }
        const query = requireRecord(params, "sessions.list params");
        if (query.search === archivedKey) {
          return sessionsResult([{ ...newerRow }], 20);
        }
        if (initialPrimary) {
          initialPrimary = false;
          return sessionsResult([{ ...primaryRow }], 1);
        }
        if (holdAll) {
          allDispatched.resolve();
          return delayed.promise;
        }
        return sessionsResult([{ ...latestRow }, { ...primaryRow }], 30);
      });
      const { sessions, watch, settle, listResult } = ownRoster(
        createGatewayHarness(client).gateway,
      );
      watch(completingQuery);
      watch(searchQuery);
      let older = Promise.resolve();
      settle(() => {
        delayed.resolve(oldAll);
        return older;
      });
      await sessions.refresh({ agentId: "main", force: true });
      const primary = sessions.state.result;
      const primaryRevision = sessions.canonicalListRevision;
      older = sessions.refreshList({ ...completingQuery, force: true });
      await allDispatched.promise;
      await sessions.refreshList({ ...searchQuery, force: true });
      const searchResult = listResult(searchQuery);
      expect(searchResult?.sessions).toEqual([expect.objectContaining(newerRow)]);
      expect(sessions.state.result).toBe(primary);

      delayed.resolve(oldAll);
      await older;
      expect(listResult(completingQuery)).toMatchObject({
        ts: 10,
        count: 2,
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        sessions: [newerRow, primaryRow],
      });
      expect(listResult(searchQuery)).toBe(searchResult);
      if (managed) {
        expect(sessions.state.result).toBe(primary);
      }
      expect(sessions.canonicalListRevision).toBe(primaryRevision + (managed ? 0 : 1));

      holdAll = false;
      await sessions.refreshList({ ...completingQuery, force: true });
      expect(listResult(completingQuery)?.sessions).toEqual([
        expect.objectContaining(latestRow),
        expect.objectContaining(primaryRow),
      ]);
      expect(listResult(searchQuery)).toBe(searchResult);
      if (managed) {
        expect(sessions.state.result).toBe(primary);
      }
      expect(unexpectedMethods).toEqual([]);
    },
  );

  it.each([
    { name: "primary", scope: { agentId: " Main " } },
    { name: "all-agents", scope: {} },
  ])("invalidates the $name roster only for matching or unscoped events", async ({ scope }) => {
    vi.useFakeTimers();
    const request = vi.fn(async () => sessionsResult([], 1));
    const { sessions, emitEvent } = rosterFixture(
      request as unknown as GatewayBrowserClient["request"],
      {
        ownerId: "profile-self",
      },
    );
    await sessions.refresh({ ...scope, force: true });
    request.mockClear();
    for (const agentId of ["research", "main", undefined]) {
      emitEvent(message({ sessionKey: "global", agentId, hasActiveRun: false, status: "done" }));
      await advance(5_000);
      expect(request).toHaveBeenCalledTimes(agentId === "research" && scope.agentId ? 0 : 1);
      request.mockClear();
    }
  });

  it.each([
    { weakKind: "append", weakOptions: { offset: 25, append: true }, outcome: "rows" },
    { weakKind: "background", weakOptions: { backgroundHydrate: true }, outcome: "error" },
  ] as const)(
    "keeps a queued Research replacement ahead of a later Work $weakKind after stale Work $outcome",
    async ({ weakOptions, outcome }) => {
      const workList = createDeferred<SessionsListResult>();
      const researchList = createDeferred<SessionsListResult>();
      const workResult = resultFor("work", 1);
      const researchResult = resultFor("research", 2);
      const { request, sessions, watch, resolveOnCleanup, settle } = queuedLists({
        work: workList,
        research: researchList,
      });
      const observed: Array<{
        result: SessionsListResult | null;
        error: string | null;
      }> = [];
      const unsubscribe = sessions.subscribe(({ result, error }) => {
        observed.push({ result, error });
      });
      const workSettled = vi.fn();
      const researchSettled = vi.fn();
      const weakSettled = vi.fn();
      const work = sessions.refresh({ agentId: "work", force: true }).then(workSettled);
      const research = sessions.refresh({ agentId: "research", force: true }).then(researchSettled);
      const weak = sessions
        .refresh({ agentId: "work", limit: 25, force: true, ...weakOptions })
        .then(weakSettled);
      resolveOnCleanup([workList, workResult], [researchList, researchResult]);
      watch(unsubscribe);
      settle(() => Promise.all([work, research, weak]));
      if (outcome === "rows") {
        workList.resolve(workResult);
      } else {
        workList.reject(new Error("stale Work failure"));
      }
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(workSettled).toHaveBeenCalledOnce());

      expect(researchSettled).not.toHaveBeenCalled();
      expect(weakSettled).not.toHaveBeenCalled();
      expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "research" });
      expect(
        observed.some(({ result }) =>
          result?.sessions.some((row) => row.key === "agent:work:main"),
        ),
      ).toBe(false);
      expect(observed.some(({ error }) => error === "stale Work failure")).toBe(false);

      researchList.resolve(researchResult);
      await Promise.all([research, weak]);
      expect(researchSettled).toHaveBeenCalledOnce();
      expect(weakSettled).toHaveBeenCalledOnce();
      expect(sessions.state.agentId).toBe("research");
      expect(sessions.state.result).toStrictEqual(researchResult);
      expect(sessions.state.error).toBeNull();
    },
  );

  it.each([
    { kind: "background", options: { backgroundHydrate: true } },
    { kind: "append", options: { append: true, offset: 1 } },
  ] as const)(
    "settles loading when remembered reconciliation follows a queued explicit $kind",
    async ({ options }) => {
      const initialList = createDeferred<SessionsListResult>();
      const refreshed = sessionsResult(
        [{ key: "agent:main:latest", kind: "direct", updatedAt: 2 }],
        2,
      );
      const request = vi.fn().mockReturnValueOnce(initialList.promise).mockResolvedValue(refreshed);
      const { sessions, resolveOnCleanup, settle } = rosterFixture(request);
      const active = sessions.refresh({ agentId: "main", force: true });
      const queued = sessions.refresh({ agentId: "main", limit: 25, force: true, ...options });
      const remembered = sessions.refreshReplacement();
      resolveOnCleanup([initialList, sessionsResult([], 1)]);
      settle(() => Promise.all([active, queued, remembered]));
      expect(sessions.state.loading).toBe(true);
      initialList.resolve(sessionsResult([], 1));
      await Promise.all([active, queued, remembered]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.state.loading).toBe(false);
      expect(sessions.state.result?.sessions).toEqual(refreshed.sessions);
      expect(sessions.state.error).toBeNull();
    },
  );

  it.each([
    { weakKind: "append", weakOptions: { offset: 25, append: true } },
    { weakKind: "background", weakOptions: { backgroundHydrate: true } },
  ] as const)(
    "lets a foreground replacement supersede an already queued $weakKind",
    async ({ weakOptions }) => {
      const activeList = createDeferred<SessionsListResult>();
      const researchList = createDeferred<SessionsListResult>();
      const researchResult = resultFor("research", 2);
      const { request, sessions, resolveOnCleanup, settle } = queuedLists({
        work: activeList,
        research: researchList,
      });
      const active = sessions.refresh({ agentId: "work", force: true });
      const weak = sessions.refresh({
        agentId: "work",
        limit: 25,
        force: true,
        ...weakOptions,
      });
      const research = sessions.refresh({ agentId: "research", force: true });
      resolveOnCleanup([activeList, sessionsResult([], 1)], [researchList, researchResult]);
      settle(() => Promise.all([active, weak, research]));
      activeList.resolve(sessionsResult([], 1));
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "research" });

      researchList.resolve(researchResult);
      await Promise.all([active, weak, research]);
      expect(sessions.state.agentId).toBe("research");
      expect(sessions.state.result).toStrictEqual(researchResult);
    },
  );

  it.each([
    { scenario: "a superseding query", nextAgentId: "research", superseded: true },
    { scenario: "an equivalent query", nextAgentId: " writer ", superseded: false },
  ])("coalesces queued foreground refreshes for $scenario", async ({ nextAgentId, superseded }) => {
    const initialList = createDeferred<SessionsListResult>();
    const replacementList = createDeferred<SessionsListResult>();
    const initialResult = resultFor("initial", 1);
    const writerResult = resultFor("writer", 2);
    const researchResult = resultFor("research", 3);
    const replacementResult = superseded ? researchResult : writerResult;
    const normalizedAgentId = nextAgentId.trim();
    const { request, sessions, resolveOnCleanup, settle } = queuedLists({
      initial: initialList,
      [normalizedAgentId]: replacementList,
    });
    const initial = sessions.refresh({ agentId: "initial", force: true });
    const writer = sessions.refresh({ agentId: "writer", force: true });
    const replacement = sessions.refresh({ agentId: nextAgentId, force: true });
    resolveOnCleanup([initialList, initialResult], [replacementList, replacementResult]);
    settle(() => Promise.all([initial, writer, replacement]));
    expect(request).toHaveBeenCalledOnce();
    initialList.resolve(initialResult);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    replacementList.resolve(replacementResult);
    const [writerOutcome, replacementOutcome] = await Promise.all([writer, replacement]);

    expect(writerOutcome).toBeUndefined();
    expect(replacementOutcome).toBeUndefined();
    expect(sessions.state.agentId).toBe(normalizedAgentId);
    expect(sessions.state.result).toStrictEqual(replacementResult);
    expect(request.mock.calls.map(([, params]) => params?.agentId)).toEqual([
      "initial",
      normalizedAgentId,
    ]);
  });

  it("settles coalesced refresh callers without waiting for a later replacement", async () => {
    const initialList = createDeferred<SessionsListResult>();
    const coalescedList = createDeferred<SessionsListResult>();
    const laterList = createDeferred<SessionsListResult>();
    const { request, sessions, resolveOnCleanup, settle } = queuedLists({
      initial: initialList,
      coalesced: coalescedList,
      later: laterList,
    });
    const initialSettled = vi.fn();
    const coalescedSettled = vi.fn();
    const initial = sessions.refresh({ agentId: "initial", force: true }).then(initialSettled);
    const first = sessions.refresh({ agentId: "superseded", force: true }).then(coalescedSettled);
    const second = sessions.refresh({ agentId: "coalesced", force: true }).then(coalescedSettled);
    let later = Promise.resolve();
    resolveOnCleanup(
      [initialList, sessionsResult([], 1)],
      [coalescedList, sessionsResult([], 2)],
      [laterList, sessionsResult([], 3)],
    );
    settle(() => Promise.all([initial, first, second, later]));
    expect(sessions.state.loading).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    initialList.resolve(sessionsResult([], 1));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(initialSettled).toHaveBeenCalledOnce());
    expect(coalescedSettled).not.toHaveBeenCalled();

    later = sessions.refresh({ agentId: "later", force: true });
    coalescedList.resolve(sessionsResult([], 2));
    await waitForFast(() => expect(coalescedSettled).toHaveBeenCalledTimes(2));

    expect(coalescedSettled.mock.calls).toEqual([[undefined], [undefined]]);
    expect(sessions.state.result).toBeNull();
    expect(sessions.state.loading).toBe(true);
    expect(request.mock.calls.map(([, params]) => params?.agentId)).toEqual([
      "initial",
      "coalesced",
      "later",
    ]);
    const laterResult = sessionsResult([], 3);
    laterList.resolve(laterResult);
    await expect(later).resolves.toBeUndefined();
    expect(sessions.state.result?.ts).toBe(3);
    expect(sessions.state.loading).toBe(false);
  });

  it.each(["disconnect", "same-client reconnect", "replacement-client reconnect", "dispose"])(
    "settles unissued refreshes on %s without dispatching them through a replacement owner",
    async (retirement) => {
      const activeList = createDeferred<SessionsListResult>();
      const refreshed = sessionsResult([], 2);
      let firstList = true;
      const request = listRequest<{ search?: string; agentId?: string }>((params) => {
        if (firstList) {
          firstList = false;
          expect(params?.search).toBe("active");
          return activeList.promise;
        }
        return refreshed;
      });
      const replacementRequest = listRequest<{ search?: string; agentId?: string }>(
        () => refreshed,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const replacement = { request: replacementRequest } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      const { sessions, resolveOnCleanup, settle } = ownRoster(gateway);
      const retired = vi.fn();
      const active = sessions.refresh({ search: "active", force: true });
      const first = sessions.refresh({ agentId: "unissued-first", force: true }).then(retired);
      const second = sessions.refresh({ agentId: "unissued-second", force: true }).then(retired);
      const remembered = sessions.refreshReplacement().then(retired);
      resolveOnCleanup([activeList, sessionsResult([], 1)]);
      settle(() => Promise.all([active, first, second, remembered]));
      expect(request).toHaveBeenCalledTimes(1);
      if (retirement === "dispose") {
        sessions.dispose();
      } else {
        publish(false);
        if (retirement !== "disconnect") {
          publish(true, retirement === "same-client reconnect" ? client : replacement);
        }
      }
      await waitForFast(() => expect(retired).toHaveBeenCalledTimes(3));
      expect(retired.mock.calls).toEqual([[undefined], [undefined], [null]]);
      if (retirement.endsWith("reconnect")) {
        await waitForFast(() => expect(sessions.state.result?.ts).toBe(2));
      } else {
        await expect(sessions.refreshReplacement()).resolves.toBeNull();
      }

      activeList.resolve(sessionsResult([], 1));
      await active;
      expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
        retirement === "same-client reconnect" ? 2 : 1,
      );
      expect(
        replacementRequest.mock.calls.filter(([method]) => method === "sessions.list"),
      ).toHaveLength(retirement === "replacement-client reconnect" ? 1 : 0);
      expect(
        [...request.mock.calls, ...replacementRequest.mock.calls]
          .filter(([method]) => method === "sessions.list")
          .map(([, params]) => params?.agentId),
      ).not.toEqual(expect.arrayContaining([expect.stringMatching(/^unissued-/)]));
      if (retirement.endsWith("reconnect")) {
        expect(sessions.state.result?.ts).toBe(2);
      } else if (retirement === "disconnect") {
        expect(sessions.state.result).toBeNull();
      }
    },
  );
});
