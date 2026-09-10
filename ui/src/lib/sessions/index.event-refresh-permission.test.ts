// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each([
  { eventKey: "agent:research:other", outcome: "success" },
  { eventKey: "agent:research:other", outcome: "failure" },
  { eventKey: "agent:main:other", outcome: "success" },
  { eventKey: "agent:main:other", outcome: "failure" },
  { eventKey: "agent:main:visible", outcome: "success" },
  { eventKey: "agent:main:visible", outcome: "failure" },
])(
  "settles a roster refresh $outcome during an active message for $eventKey",
  async ({ eventKey, outcome }) => {
    vi.useFakeTimers();
    const key = "agent:main:visible";
    const row = { key, kind: "direct" as const, sessionId: "visible-generation", updatedAt: 1 };
    const initial = sessionsResult([row], 1);
    const response = sessionsResult([{ ...row, label: "Refreshed", updatedAt: 3 }], 3);
    const pending = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return listCalls === 1 ? initial : pending.promise;
    });
    const { sessions, emitEvent } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    try {
      await sessions.refresh({ agentId: "main", force: true });
      const refresh = sessions.refresh({ agentId: "main", force: true });
      expect(listCalls).toBe(2);
      expect(sessions.state.loading).toBe(true);

      emitEvent({
        type: "event",
        event: "session.message",
        payload: {
          sessionKey: eventKey,
          key: eventKey,
          kind: "direct",
          sessionId: eventKey === key ? row.sessionId : "other-generation",
          updatedAt: 2,
          archived: false,
          permissionMode: null,
          hasActiveRun: true,
          status: "running",
        },
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
    } finally {
      pending.resolve(response);
      sessions.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "publishes an active message into its existing Sessions page row (newer overlap: %s)",
  async (newerOverlap) => {
    const primary: GatewaySessionRow = {
      key: "agent:main:primary-a",
      sessionId: "primary-a-session",
      kind: "direct",
      updatedAt: 10,
      label: "Primary A",
    };
    const managed: GatewaySessionRow = {
      key: "agent:main:managed-b",
      sessionId: "managed-b-session",
      kind: "direct",
      updatedAt: 10,
      label: "Managed B",
      archived: false,
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    };
    const primaryRows = newerOverlap ? [primary, { ...managed }] : [primary];
    if (newerOverlap) {
      managed.updatedAt = 30;
      managed.label = "Newer managed B";
    }
    const query = {
      agentId: "main",
      search: managed.key,
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
      archivedFilter: "active" as const,
      limit: 50,
    };
    const request = createGatewayRequestMock(async (method, params) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const search = asOptionalRecord(params)?.search;
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
    const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);
    const observed: Array<GatewaySessionRow | undefined> = [];
    const unsubscribe = sessions.subscribeList(query, (snapshot) => {
      observed.push(snapshot.result?.sessions.find((row) => row.key === managed.key));
    });
    const message = (updatedAt: number, label: string, runId: string) => {
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
          key: managed.key,
          sessionId: managed.sessionId,
          kind: "direct",
          updatedAt,
          label,
          archived: false,
          status: "running",
          hasActiveRun: true,
          activeRunIds: [runId],
          startedAt: updatedAt,
          permissionMode: null,
        },
      });
      const payload: unknown = JSON.parse(wire);
      emitEvent({ type: "event", event: "session.message", payload });
    };

    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList(query);
      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.state.result?.sessions).toEqual(primaryRows);
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([managed]);
      const initialPrimary = sessions.state.result;

      message(5, "Older B", "older-run");
      expect(sessions.listSnapshot(query).result?.sessions).toEqual([managed]);
      expect(observed.at(-1)).toEqual(managed);
      observed.length = 0;

      message(20, "Current B", "current-run");
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
    } finally {
      unsubscribe();
      sessions.dispose();
    }
  },
);
