// @vitest-environment node
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const requireRecord = createRequireRecord("object", "expected-label");

describe("session roster refresh", () => {
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
      const client = createTestGatewayClient(async (method) => {
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
      });
      const { gateway, publish } = createGatewayHarness(client);
      const coordinator = createConnectionBootstrapCoordinator();
      coordinator.synchronize({ client, connected: true });
      const sessions = createSessionCapability(
        gateway,
        { state: { selectedId: "main" }, subscribe: () => () => undefined },
        { connectionBootstrap: coordinator },
      );
      const explicit = sessions.refresh({ agentId: "main", force: true });
      try {
        publish(true);
        await vi.advanceTimersByTimeAsync(100);
        expect(reads).toBe(1);
        expect(subscriptions).toBe(recover ? 2 : 1);
        coordinator.setForegroundRoute("agent:main:next-chat");
        initial.resolve(sessionsResult([], 1));
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(1);
        if (replaceDuringHold) {
          await sessions.refresh({ agentId: "main", force: true, backgroundHydrate: true });
          expect(reads).toBe(2);
        }
        coordinator.setForegroundPane(
          {},
          { sessionKey: "agent:main:next-chat", client, ready: true },
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(2);
        expect(sessions.state.result?.ts).toBe(2);
      } finally {
        initial.resolve(sessionsResult([], 1));
        sessions.dispose();
        coordinator.reset();
        await explicit;
        vi.useRealTimers();
      }
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
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const paramsRecord = requireRecord(params, "sessions.list params");
        if (paramsRecord.agentId !== agentId || (managed && paramsRecord.spawnedBy !== parentKey)) {
          return sessionsResult([], 0);
        }
        reads += 1;
        return reads === 2 ? slow.promise : result(reads);
      });
      const client = createTestGatewayClient(request);
      const { gateway, emitEvent } = createGatewayHarness(client);
      const coordinator = createConnectionBootstrapCoordinator();
      coordinator.synchronize({ client, connected: true });
      const sessions = createSessionCapability(
        gateway,
        { state: { selectedId: "main" }, subscribe: () => () => undefined },
        { connectionBootstrap: coordinator },
      );
      const invalidate = () =>
        emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey: key, key, agentId, reason: "patch", spawnedBy: parentKey },
        });
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
      try {
        await (subscription ? subscription.refresh() : sessions.refresh(query));
        expect(reads).toBe(1);
        if (explicit === "readmission") {
          coordinator.setForegroundRoute("agent:main:first-chat");
        }
        invalidate();
        await vi.advanceTimersByTimeAsync(200);
        const delayedExplicit = explicit === "readmission" ? subscription?.refresh() : null;
        expect(reads).toBe(2);
        if (explicit === "readmission") {
          coordinator.setForegroundPane(
            {},
            { sessionKey: "agent:main:first-chat", client, ready: true },
          );
          await vi.advanceTimersByTimeAsync(0);
        } else if (timing === "the pending RPC") {
          invalidate();
          await vi.advanceTimersByTimeAsync(200);
          expect(reads).toBe(2);
        }
        const nextChatHoldsRefresh = timing === "the pending RPC";
        if (nextChatHoldsRefresh) {
          coordinator.setForegroundRoute("agent:main:next-chat");
        }
        const explicitRefresh = explicit === "pending" ? subscription?.refresh() : null;
        slow.resolve(result(2));
        await vi.advanceTimersByTimeAsync(1_000);
        if (nextChatHoldsRefresh) {
          expect(reads).toBe(explicit === "pending" ? 3 : 2);
          if (explicit === "held") {
            await subscription?.refresh();
            expect(reads).toBe(3);
          }
          coordinator.setForegroundPane(
            {},
            { sessionKey: "agent:main:next-chat", client, ready: true },
          );
          await vi.advanceTimersByTimeAsync(0);
        }
        await explicitRefresh;
        await delayedExplicit;
        expect(reads).toBe(3);
        expect(current).toMatchObject({ ts: 3, sessions: [{ key, label: "Revision 3" }] });
      } finally {
        slow.resolve(result(2));
        stop();
        sessions.dispose();
        coordinator.reset();
        vi.useRealTimers();
      }
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
      const sessions = createTestSessionCapability(createGatewayHarness(client).gateway);
      const stopAll = sessions.subscribeList(completingQuery, () => {});
      const stopSearch = sessions.subscribeList(searchQuery, () => {});
      let older: Promise<void> | undefined;
      try {
        await sessions.refresh({ agentId: "main", force: true });
        const primary = sessions.state.result;
        const primaryRevision = sessions.canonicalListRevision;
        older = sessions.refreshList({ ...completingQuery, force: true });
        await allDispatched.promise;
        await sessions.refreshList({ ...searchQuery, force: true });
        const searchResult = sessions.listSnapshot(searchQuery).result;
        expect(searchResult?.sessions).toEqual([expect.objectContaining(newerRow)]);
        expect(sessions.state.result).toBe(primary);

        delayed.resolve(oldAll);
        await older;
        expect(sessions.listSnapshot(completingQuery).result).toMatchObject({
          ts: 10,
          count: 2,
          totalCount: 2,
          hasMore: false,
          nextOffset: null,
          sessions: [newerRow, primaryRow],
        });
        expect(sessions.listSnapshot(searchQuery).result).toBe(searchResult);
        if (managed) {
          expect(sessions.state.result).toBe(primary);
        }
        expect(sessions.canonicalListRevision).toBe(primaryRevision + (managed ? 0 : 1));

        holdAll = false;
        await sessions.refreshList({ ...completingQuery, force: true });
        expect(sessions.listSnapshot(completingQuery).result?.sessions).toEqual([
          expect.objectContaining(latestRow),
          expect.objectContaining(primaryRow),
        ]);
        expect(sessions.listSnapshot(searchQuery).result).toBe(searchResult);
        if (managed) {
          expect(sessions.state.result).toBe(primary);
        }
        expect(unexpectedMethods).toEqual([]);
      } finally {
        stopAll();
        stopSearch();
        sessions.dispose();
        delayed.resolve(oldAll);
        await older;
      }
    },
  );

  it.each([
    { name: "primary", scope: { agentId: " Main " } },
    { name: "owner-first", scope: { agentId: "main", ownerFirst: true } },
    { name: "owner-filtered", scope: { agentId: "main", ownerId: "profile-self" } },
    { name: "involving-me", scope: { agentId: "main", involvingMe: true } },
    { name: "searched", scope: { agentId: "main", search: "report" } },
    { name: "all-agents", scope: {} },
  ])("invalidates the $name roster only for matching or unscoped events", async ({ scope }) => {
    vi.useFakeTimers();
    const request = vi.fn(async () => sessionsResult([], 1));
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
      { ownerId: "profile-self" },
    );
    try {
      await sessions.refresh({ ...scope, force: true });
      request.mockClear();
      for (const agentId of ["research", "main", undefined]) {
        emitEvent({
          type: "event",
          event: "session.message",
          payload: { sessionKey: "global", agentId, hasActiveRun: false, status: "done" },
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(request).toHaveBeenCalledTimes(agentId === "research" && scope.agentId ? 0 : 1);
        request.mockClear();
      }
    } finally {
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    { weakKind: "append", weakOptions: { offset: 25, append: true }, outcome: "rows" },
    { weakKind: "append", weakOptions: { offset: 25, append: true }, outcome: "error" },
    { weakKind: "background", weakOptions: { backgroundHydrate: true }, outcome: "rows" },
    { weakKind: "background", weakOptions: { backgroundHydrate: true }, outcome: "error" },
  ] as const)(
    "keeps a queued Research replacement ahead of a later Work $weakKind after stale Work $outcome",
    async ({ weakOptions, outcome }) => {
      const workList = createDeferred<SessionsListResult>();
      const researchList = createDeferred<SessionsListResult>();
      const workResult = sessionsResult(
        [{ key: "agent:work:main", kind: "direct", updatedAt: 1 }],
        1,
      );
      const researchResult = sessionsResult(
        [{ key: "agent:research:main", kind: "direct", updatedAt: 2 }],
        2,
      );
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.agentId === "work") {
          return await workList.promise;
        }
        if (params?.agentId === "research") {
          return await researchList.promise;
        }
        throw new Error(`Unexpected refresh: ${params?.agentId}`);
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
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

      try {
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
        expect(sessions.state.result).toBe(researchResult);
        expect(sessions.state.error).toBeNull();
      } finally {
        workList.resolve(workResult);
        researchList.resolve(researchResult);
        unsubscribe();
        sessions.dispose();
        await Promise.all([work, research, weak]);
      }
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
      const { sessions } = createSessionCapabilityHarness(request);
      const active = sessions.refresh({ agentId: "main", force: true });
      const queued = sessions.refresh({ agentId: "main", limit: 25, force: true, ...options });
      const remembered = sessions.refreshReplacement();
      try {
        expect(sessions.state.loading).toBe(true);
        initialList.resolve(sessionsResult([], 1));
        await Promise.all([active, queued, remembered]);
        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.state.loading).toBe(false);
        expect(sessions.state.result?.sessions).toEqual(refreshed.sessions);
        expect(sessions.state.error).toBeNull();
      } finally {
        initialList.resolve(sessionsResult([], 1));
        sessions.dispose();
        await Promise.all([active, queued, remembered]);
      }
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
      const researchResult = sessionsResult(
        [{ key: "agent:research:main", kind: "direct", updatedAt: 2 }],
        2,
      );
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.agentId === "work") {
          return await activeList.promise;
        }
        if (params?.agentId === "research") {
          return await researchList.promise;
        }
        throw new Error(`Unexpected refresh: ${params?.agentId}`);
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const active = sessions.refresh({ agentId: "work", force: true });
      const weak = sessions.refresh({
        agentId: "work",
        limit: 25,
        force: true,
        ...weakOptions,
      });
      const research = sessions.refresh({ agentId: "research", force: true });

      try {
        activeList.resolve(sessionsResult([], 1));
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls[1]?.[1]).toMatchObject({ agentId: "research" });

        researchList.resolve(researchResult);
        await Promise.all([active, weak, research]);
        expect(sessions.state.agentId).toBe("research");
        expect(sessions.state.result).toBe(researchResult);
      } finally {
        activeList.resolve(sessionsResult([], 1));
        researchList.resolve(researchResult);
        sessions.dispose();
        await Promise.all([active, weak, research]);
      }
    },
  );

  it.each([
    { scenario: "a superseding query", nextAgentId: "research", superseded: true },
    { scenario: "an equivalent query", nextAgentId: " writer ", superseded: false },
  ])(
    "keeps queued replacement results with their query for $scenario",
    async ({ nextAgentId, superseded }) => {
      const initialList = createDeferred<SessionsListResult>();
      const replacementList = createDeferred<SessionsListResult>();
      const initialResult = sessionsResult(
        [{ key: "agent:initial:main", kind: "direct", updatedAt: 1 }],
        1,
      );
      const writerResult = sessionsResult(
        [{ key: "agent:writer:main", kind: "direct", updatedAt: 2 }],
        2,
      );
      const researchResult = sessionsResult(
        [{ key: "agent:research:main", kind: "direct", updatedAt: 3 }],
        3,
      );
      const replacementResult = superseded ? researchResult : writerResult;
      const normalizedAgentId = nextAgentId.trim();
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        expect(method).toBe("sessions.list");
        if (params?.agentId === "initial") {
          return await initialList.promise;
        }
        if (params?.agentId === normalizedAgentId) {
          return await replacementList.promise;
        }
        throw new Error(`Unexpected refresh: ${params?.agentId}`);
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const initial = sessions.refresh({ agentId: "initial", force: true });
      const writer = sessions.refreshReplacement("writer");
      const replacement = sessions.refreshReplacement(nextAgentId);

      try {
        expect(request).toHaveBeenCalledOnce();
        initialList.resolve(initialResult);
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
        replacementList.resolve(replacementResult);
        const [writerOutcome, replacementOutcome] = await Promise.all([writer, replacement]);

        expect(writerOutcome).toBe(superseded ? null : writerResult);
        expect(replacementOutcome).toBe(replacementResult);
        expect(sessions.state.agentId).toBe(normalizedAgentId);
        expect(sessions.state.result).toBe(replacementResult);
        expect(request.mock.calls.map(([, params]) => params?.agentId)).toEqual([
          "initial",
          normalizedAgentId,
        ]);
      } finally {
        initialList.resolve(initialResult);
        replacementList.resolve(replacementResult);
        sessions.dispose();
        await Promise.all([initial, writer, replacement]);
      }
    },
  );

  it("settles coalesced refresh callers without waiting for a later replacement", async () => {
    const initialList = createDeferred<SessionsListResult>();
    const coalescedList = createDeferred<SessionsListResult>();
    const laterList = createDeferred<SessionsListResult>();
    const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
      expect(method).toBe("sessions.list");
      switch (params?.agentId) {
        case "initial":
          return await initialList.promise;
        case "coalesced":
          return await coalescedList.promise;
        case "later":
          return await laterList.promise;
        default:
          throw new Error(`Unexpected refresh: ${params?.agentId}`);
      }
    });
    const { sessions } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const initialSettled = vi.fn();
    const coalescedSettled = vi.fn();
    const initial = sessions.refresh({ agentId: "initial", force: true }).then(initialSettled);
    const first = sessions.refreshReplacement("superseded").then(coalescedSettled);
    const second = sessions.refreshReplacement("coalesced").then(coalescedSettled);
    let later: ReturnType<typeof sessions.refreshReplacement> | undefined;

    try {
      expect(sessions.state.loading).toBe(true);
      expect(request).toHaveBeenCalledTimes(1);
      initialList.resolve(sessionsResult([], 1));
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(initialSettled).toHaveBeenCalledOnce());
      expect(coalescedSettled).not.toHaveBeenCalled();

      later = sessions.refreshReplacement("later");
      coalescedList.resolve(sessionsResult([], 2));
      await waitForFast(() => expect(coalescedSettled).toHaveBeenCalledTimes(2));

      expect(coalescedSettled.mock.calls).toEqual([[null], [null]]);
      expect(sessions.state.result).toBeNull();
      expect(sessions.state.loading).toBe(true);
      expect(request.mock.calls.map(([, params]) => params?.agentId)).toEqual([
        "initial",
        "coalesced",
        "later",
      ]);
      const laterResult = sessionsResult([], 3);
      laterList.resolve(laterResult);
      await expect(later).resolves.toBe(laterResult);
      expect(sessions.state.result?.ts).toBe(3);
      expect(sessions.state.loading).toBe(false);
    } finally {
      initialList.resolve(sessionsResult([], 1));
      coalescedList.resolve(sessionsResult([], 2));
      laterList.resolve(sessionsResult([], 3));
      sessions.dispose();
      await Promise.all([initial, first, second, later]);
    }
  });

  it("returns a failed replacement outcome while preserving the previous roster", async () => {
    const previous = sessionsResult([{ key: "agent:main:main", kind: "direct", updatedAt: 1 }], 1);
    const request = vi
      .fn()
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error("Roster unavailable"));
    const { sessions } = createSessionCapabilityHarness(request);
    try {
      await sessions.refresh({ agentId: "main", search: "draft", force: true });
      await expect(sessions.refreshReplacement()).resolves.toBeNull();
      expect(sessions.state.result).toBe(previous);
      expect(sessions.state.error).toBe("Roster unavailable");
    } finally {
      sessions.dispose();
    }
  });

  it.each(["disconnect", "same-client reconnect", "replacement-client reconnect", "dispose"])(
    "settles unissued refreshes on %s without dispatching them through a replacement owner",
    async (retirement) => {
      const activeList = createDeferred<SessionsListResult>();
      const refreshed = sessionsResult([], 2);
      let firstList = true;
      const request = vi.fn(
        async (method: string, params?: { search?: string; agentId?: string }) => {
          if (method === "sessions.subscribe") {
            return { subscribed: true };
          }
          if (method === "sessions.list") {
            if (firstList) {
              firstList = false;
              expect(params?.search).toBe("active");
              return activeList.promise;
            }
            return refreshed;
          }
          throw new Error(`Unexpected request: ${method} ${params?.search}`);
        },
      );
      const replacementRequest = vi.fn(
        async (method: string, _params?: { search?: string; agentId?: string }) => {
          if (method === "sessions.subscribe") {
            return { subscribed: true };
          }
          expect(method).toBe("sessions.list");
          return refreshed;
        },
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const replacement = { request: replacementRequest } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      const retired = vi.fn();
      const active = sessions.refresh({ search: "active", force: true });
      const first = sessions.refreshReplacement("unissued-first").then(retired);
      const second = sessions.refreshReplacement("unissued-second").then(retired);
      const remembered = sessions.refreshReplacement().then(retired);

      try {
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
        expect(retired.mock.calls).toEqual([[null], [null], [null]]);
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
      } finally {
        activeList.resolve(sessionsResult([], 1));
        sessions.dispose();
        await Promise.all([active, first, second, remembered]);
      }
    },
  );
});
