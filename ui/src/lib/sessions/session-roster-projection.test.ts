// @vitest-environment node
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionCapability } from "./session-capability.ts";

const makeRow = (id: string, label: string) => ({
  key: `agent:main:${id}`,
  sessionId: id,
  kind: "direct" as const,
  label,
  updatedAt: 1,
});
type Row = ReturnType<typeof makeRow>;
const makeQuery = (limit: number) => ({ agentId: "main", search: "Shared", limit });
const changed = (row: Row, reason: string, label: string, updatedAt = 1) => ({
  type: "event" as const,
  event: "sessions.changed",
  payload: {
    sessionKey: row.key,
    agentId: "main",
    sessionId: row.sessionId,
    reason,
    label,
    updatedAt,
  },
});
function makeHarness(result: (params?: unknown) => SessionsListResult) {
  vi.useFakeTimers();
  const request = createGatewayRequestMock(async (method, params) => {
    expect(method).toBe("sessions.list");
    return result(params);
  });
  const client = createTestGatewayClient(request);
  const harness = createSessionCapabilityHarness(client.request.bind(client));
  const cleanup: Array<() => void> = [];
  onTestFinished(() => {
    cleanup.forEach((dispose) => dispose());
    harness.sessions.dispose();
    vi.useRealTimers();
  });
  const subscribe = (...args: Parameters<SessionCapability["subscribeList"]>) =>
    cleanup.push(harness.sessions.subscribeList(...args));
  return { ...harness, request, subscribe, cleanup };
}

describe("event-driven session list refresh", () => {
  it("bounds held-roster enumeration while reconciling overlapping session views", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      makeRow(`shared-${index}`, `Shared ${index}`),
    );
    const { sessions, emitEvent, request, subscribe, cleanup } = makeHarness(() =>
      sessionsResult(structuredClone(rows), 1),
    );
    const queries = Array.from({ length: 8 }, (_, index) => makeQuery(10 + index));
    queries.forEach((query) => subscribe(query, () => undefined));
    const target = rows[0]!;
    const observed = vi.fn();
    let descriptor: ReturnType<SessionCapability["observeRow"]> | null = null;
    const heldResults = () => [
      sessions.state.result,
      ...queries.map((query) => sessions.listSnapshot(query).result),
    ];
    const findTarget = (result: SessionsListResult | null | undefined) =>
      result?.sessions.find((row) => row.key === target.key);
    const eventDelivered = vi.fn(() => ({
      descriptor: descriptor?.row,
      rows: heldResults().map(findTarget),
    }));
    await sessions.refresh({ agentId: "main", force: true });
    for (const query of queries) {
      await sessions.refreshList({ ...query, force: true });
    }
    descriptor = sessions.observeRow({ key: target.key, agentId: "main" }, observed, {
      onEvent: eventDelivered,
    });
    cleanup.unshift(() => descriptor?.dispose());
    observed.mockClear();
    const event = changed(target, "update", "Shared updated", 2);
    const held = heldResults();
    const heldRowCount = held.reduce((count, result) => count + (result?.sessions.length ?? 0), 0);
    let visitedRows = 0;
    for (const source of new Set(held.flatMap((result) => (result ? [result.sessions] : [])))) {
      // Count whole-source enumeration; values() bypasses this replaced iterator.
      Object.defineProperty(source, Symbol.iterator, {
        configurable: true,
        *value() {
          for (const row of source.values()) {
            visitedRows++;
            yield row;
          }
        },
      });
    }
    emitEvent(event);
    const expected = expect.objectContaining({ label: "Shared updated", updatedAt: 2 });
    // Allow per-view reduction and decoration; repeated whole-roster preparation is quadratic.
    expect(visitedRows).toBeLessThanOrEqual(heldRowCount * 12);
    expect(descriptor.row).toEqual(expected);
    for (const result of heldResults()) {
      expect(result?.sessions).toHaveLength(rows.length);
      expect(findTarget(result)).toEqual(expected);
    }
    expect(eventDelivered).toHaveBeenCalledExactlyOnceWith(
      event,
      expect.objectContaining({ applied: true, admittedRow: expected, row: expected }),
    );
    expect(eventDelivered).toHaveReturnedWith({
      descriptor: expected,
      rows: Array.from({ length: queries.length + 1 }, () => expected),
    });
    expect(observed).toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(queries.length + 1);
  });

  it("converges an unrelated row before managed listeners run through Gateway reconciliation", async () => {
    const first = makeRow("first", "Shared first");
    const second = { ...makeRow("second", "Shared second"), lastMessagePreview: "Before" };
    const olderQuery = makeQuery(10);
    const newerQuery = makeQuery(11);
    let fresh = false;
    const { sessions, emitEvent, request, subscribe } = makeHarness((params) => {
      const newer = fresh && asNullableRecord(params)?.limit === newerQuery.limit;
      return sessionsResult(
        [{ ...first }, { ...second, lastMessagePreview: newer ? "After" : "Before" }],
        1,
      );
    });
    let observe = false;
    const delivered: Array<Record<"older" | "newer", string | null | undefined>> = [];
    const preview = (query: typeof olderQuery) =>
      sessions.listSnapshot(query).result?.sessions.find((row) => row.key === second.key)
        ?.lastMessagePreview;
    subscribe(olderQuery, () => {
      if (observe) {
        delivered.push({ older: preview(olderQuery), newer: preview(newerQuery) });
      }
    });
    subscribe(newerQuery, () => undefined);
    await sessions.refresh({ agentId: "main", force: true });
    await sessions.refreshList({ ...olderQuery, force: true });
    await sessions.refreshList({ ...newerQuery, force: true });
    emitEvent(changed(first, "patch", first.label));
    fresh = true;
    await sessions.refreshList({ ...newerQuery, force: true });
    expect([preview(olderQuery), preview(newerQuery)]).toEqual(["Before", "After"]);
    const beforeRequests = request.mock.calls.length;
    observe = true;
    const label = "Shared first updated";
    emitEvent(changed(first, "patch", label, 2));
    expect(delivered).toEqual([{ older: "After", newer: "After" }]);
    for (const query of [olderQuery, newerQuery]) {
      expect(sessions.listSnapshot(query).result?.sessions).toHaveLength(2);
      expect(
        sessions.listSnapshot(query).result?.sessions.find((row) => row.key === first.key)?.label,
      ).toBe(label);
    }
    expect(request).toHaveBeenCalledTimes(beforeRequests);
  });
});
