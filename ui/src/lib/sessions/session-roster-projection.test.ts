// @vitest-environment node
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionCapability } from "./session-capability.ts";

describe("event-driven session list refresh", () => {
  it.each([
    { scope: "current descriptor", result: false },
    { scope: "scoped defaults", result: "defaults-only" },
    { scope: "another agent", result: true },
    { scope: "another incarnation", result: true },
    { scope: "retired descriptor", result: true },
    { scope: "live roster owner", result: true },
  ] as const)("applies captured read fences only to their $scope", async ({ scope, result }) => {
    const targetAgentId = scope === "another agent" ? "other" : "research";
    const target: GatewaySessionRow = {
      key: "global",
      kind: "global",
      agentId: targetAgentId,
      sessionId: "held-incarnation",
      updatedAt: 1,
      label: "Scoped row",
    };
    const primary: GatewaySessionRow =
      scope === "live roster owner"
        ? target
        : {
            key: "agent:main:root",
            agentId: "main",
            sessionId: "main-root",
            kind: "direct",
            updatedAt: 1,
          };
    const ownerAgentId = scope === "live roster owner" ? targetAgentId : "main";
    const request = createGatewayRequestMock(async () => sessionsResult([primary], 1));
    const client = createTestGatewayClient(request);
    const { sessions } = createSessionCapabilityHarness(client.request.bind(client));
    await sessions.refresh({ agentId: ownerAgentId, force: true });
    const observation = sessions.observeRow({ key: target.key, agentId: targetAgentId }, () => {});
    try {
      expect(observation.captureReconcile()(target).status).toBe("current");
      const reconcile = sessions.captureReconcile();
      expect(observation.captureReconcile()(undefined)).toEqual({ status: "current", row: null });
      if (scope === "retired descriptor") {
        observation.dispose();
      }
      const incoming = {
        ...target,
        agentId: "research",
        sessionId: scope === "another incarnation" ? "incoming-incarnation" : target.sessionId,
      };
      expect(
        reconcile(
          incoming,
          scope === "scoped defaults" ? sessionsResult([], 1).defaults : undefined,
          { resultAgentId: ownerAgentId, selectedGlobalAgentId: "research" },
        ),
      ).toBe(result);
      if (scope === "live roster owner") {
        expect(sessions.state.result?.sessions[0]).toMatchObject(primary);
      }
    } finally {
      observation.dispose();
      sessions.dispose();
    }
  });

  it("bounds held-roster enumeration while reconciling overlapping session views", async () => {
    vi.useFakeTimers();
    const rows = Array.from({ length: 10 }, (_, index) => ({
      key: `agent:main:shared-${index}`,
      sessionId: `shared-${index}`,
      kind: "direct" as const,
      label: `Shared ${index}`,
      updatedAt: 1,
    }));
    const request = createGatewayRequestMock(async (method) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(
        rows.map((row) => ({ ...row })),
        1,
      );
    });
    const client = createTestGatewayClient(request);
    const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
    const queries = Array.from({ length: 8 }, (_, index) => ({
      agentId: "main",
      search: "Shared",
      limit: 10 + index,
    }));
    const unsubscribers = queries.map((query) => sessions.subscribeList(query, () => undefined));
    const target = rows[0]!;
    const observed = vi.fn();
    let descriptor: ReturnType<SessionCapability["observeRow"]> | undefined;
    const eventDelivered = vi.fn(() => ({
      descriptor: descriptor?.row,
      rows: [
        sessions.state.result,
        ...queries.map((query) => sessions.listSnapshot(query).result),
      ].map((result) => result?.sessions.find((row) => row.key === target.key)),
    }));
    let visitedRows = 0;
    const tracked = new WeakSet<SessionsListResult["sessions"]>();
    const trackHeldRows = () => {
      const held = [
        sessions.state.result,
        ...queries.map((query) => sessions.listSnapshot(query).result),
      ];
      for (const result of held) {
        if (!result || tracked.has(result.sessions)) {
          continue;
        }
        const source = result.sessions;
        tracked.add(source);
        // Count complete source enumeration independently of reducer implementation and timing.
        Object.defineProperty(source, Symbol.iterator, {
          configurable: true,
          *value() {
            // Array values bypass this replaced iterator.
            for (const row of source.values()) {
              visitedRows += 1;
              yield row;
            }
          },
        });
      }
      return held.reduce((count, result) => count + (result?.sessions.length ?? 0), 0);
    };
    try {
      await sessions.refresh({ agentId: "main", force: true });
      for (const query of queries) {
        await sessions.refreshList({ ...query, force: true });
      }
      descriptor = sessions.observeRow({ key: target.key, agentId: "main" }, observed, {
        onEvent: eventDelivered,
      });
      observed.mockClear();
      const payload = {
        sessionKey: target.key,
        agentId: "main",
        sessionId: target.sessionId,
        reason: "update",
        label: "Shared updated",
        updatedAt: 2,
      };
      const heldRowCount = trackHeldRows();
      visitedRows = 0;
      const event = { type: "event" as const, event: "sessions.changed", payload };
      emitEvent(event);
      // Allow per-view reduction and decoration; repeated whole-roster preparation is quadratic.
      expect(visitedRows).toBeLessThanOrEqual(heldRowCount * 12);
      expect(descriptor.row).toMatchObject({ label: payload.label, updatedAt: 2 });
      for (const query of queries) {
        const result = sessions.listSnapshot(query).result;
        expect(result?.sessions).toHaveLength(rows.length);
        expect(result?.sessions.find((row) => row.key === target.key)).toMatchObject({
          label: payload.label,
          updatedAt: 2,
        });
      }
      expect(eventDelivered).toHaveBeenCalledExactlyOnceWith(
        event,
        expect.objectContaining({
          applied: true,
          admittedRow: expect.objectContaining({ label: payload.label, updatedAt: 2 }),
          row: expect.objectContaining({ label: payload.label, updatedAt: 2 }),
        }),
      );
      expect(eventDelivered).toHaveReturnedWith({
        descriptor: expect.objectContaining({ label: payload.label, updatedAt: 2 }),
        rows: Array.from({ length: queries.length + 1 }, () =>
          expect.objectContaining({ label: payload.label, updatedAt: 2 }),
        ),
      });
      expect(sessions.state.result?.sessions.find((row) => row.key === target.key)).toMatchObject({
        label: payload.label,
        updatedAt: 2,
      });
      expect(observed).toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(queries.length + 1);
    } finally {
      descriptor?.dispose();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("converges an unrelated row before managed listeners run through Gateway reconciliation", async () => {
    vi.useFakeTimers();
    const first = {
      key: "agent:main:first",
      sessionId: "first",
      kind: "direct" as const,
      label: "Shared first",
      updatedAt: 1,
    };
    const second = {
      key: "agent:main:second",
      sessionId: "second",
      kind: "direct" as const,
      label: "Shared second",
      lastMessagePreview: "Before",
      updatedAt: 1,
    };
    const olderQuery = { agentId: "main", search: "Shared", limit: 10 };
    const newerQuery = { agentId: "main", search: "Shared", limit: 11 };
    let fresh = false;
    const request = createGatewayRequestMock(async (method, params) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      const newer = fresh && asNullableRecord(params)?.limit === newerQuery.limit;
      return sessionsResult(
        [{ ...first }, { ...second, lastMessagePreview: newer ? "After" : "Before" }],
        1,
      );
    });
    const client = createTestGatewayClient(request);
    const { sessions, emitEvent } = createSessionCapabilityHarness(client.request.bind(client));
    let observe = false;
    const delivered: Array<{
      older: string | null | undefined;
      newer: string | null | undefined;
    }> = [];
    const preview = (query: typeof olderQuery) =>
      sessions.listSnapshot(query).result?.sessions.find((row) => row.key === second.key)
        ?.lastMessagePreview;
    const unsubscribeOlder = sessions.subscribeList(olderQuery, () => {
      if (observe) {
        delivered.push({ older: preview(olderQuery), newer: preview(newerQuery) });
      }
    });
    const unsubscribeNewer = sessions.subscribeList(newerQuery, () => undefined);
    try {
      await sessions.refresh({ agentId: "main", force: true });
      await sessions.refreshList({ ...olderQuery, force: true });
      await sessions.refreshList({ ...newerQuery, force: true });
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: first.key,
          agentId: "main",
          reason: "patch",
          sessionId: first.sessionId,
          label: first.label,
          updatedAt: 1,
        },
      });
      fresh = true;
      await sessions.refreshList({ ...newerQuery, force: true });
      expect(preview(olderQuery)).toBe("Before");
      expect(preview(newerQuery)).toBe("After");
      const beforeRequests = request.mock.calls.length;
      observe = true;
      const payload = {
        sessionKey: first.key,
        agentId: "main",
        reason: "patch",
        sessionId: first.sessionId,
        label: "Shared first updated",
        updatedAt: 2,
      };
      emitEvent({ type: "event", event: "sessions.changed", payload });
      expect(delivered).toEqual([{ older: "After", newer: "After" }]);
      for (const query of [olderQuery, newerQuery]) {
        expect(sessions.listSnapshot(query).result?.sessions).toHaveLength(2);
        expect(
          sessions.listSnapshot(query).result?.sessions.find((row) => row.key === first.key)?.label,
        ).toBe(payload.label);
      }
      expect(request).toHaveBeenCalledTimes(beforeRequests);
    } finally {
      unsubscribeOlder();
      unsubscribeNewer();
      sessions.dispose();
      vi.useRealTimers();
    }
  });
});
