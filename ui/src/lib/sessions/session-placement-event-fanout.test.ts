// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

it("patches 100 held placement updates across 40 subscribers and reads once on reconnect", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1);
  const rows: GatewaySessionRow[] = Array.from({ length: 4 }, (_, index) => ({
    key: `agent:main:placement-${index}`,
    sessionId: `placement-${index}`,
    kind: "direct",
    updatedAt: 1,
  }));
  const clients = Array.from({ length: 40 }, () => {
    const reads = vi.fn();
    const subscribed = vi.fn();
    const harness = createSubscriptionHydrationHarness(async (method) => {
      if (method === "sessions.subscribe") {
        subscribed();
        return { subscribed: true };
      }
      expect(method).toBe("sessions.list");
      reads();
      return sessionsResult(structuredClone(rows), Date.now());
    });
    return { ...harness, reads, subscribed };
  });
  try {
    for (const client of clients) {
      client.connect();
    }
    await vi.advanceTimersByTimeAsync(0);
    for (const client of clients) {
      expect(client.subscribed).toHaveBeenCalledOnce();
      expect(client.reads).toHaveBeenCalledOnce();
      client.reads.mockClear();
    }
    for (let index = 0; index < 100; index += 1) {
      const rowIndex = index % rows.length;
      const row = rows[rowIndex]!;
      const next: GatewaySessionRow = {
        ...row,
        snapshotAt: Date.now(),
        placement:
          index >= 98
            ? undefined
            : {
                state: "provisioning",
                generation: index,
                createdAtMs: 1,
                updatedAtMs: Date.now(),
                stateChangedAtMs: Date.now(),
                environmentId: `environment-${index}`,
              },
      };
      rows[rowIndex] = next;
      for (const client of clients) {
        client.emitEvent({
          type: "event",
          event: "sessions.changed",
          payload: {
            reason: "placement",
            sessionKey: next.key,
            agentId: "main",
            session: next,
            ancestorSessions: [],
            ts: Date.now(),
          },
        });
      }
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    console.log(
      "placement fan-out list requests",
      clients.reduce((sum, client) => sum + client.reads.mock.calls.length, 0),
    );
    expect.soft(clients.map((client) => client.reads.mock.calls.length)).toEqual(Array(40).fill(0));
    for (const client of clients) {
      expect(client.sessions.state.result?.sessions.map((row) => row.placement)).toEqual(
        rows.map((row) => row.placement),
      );
      client.reads.mockClear();
      client.disconnect();
      client.connect();
    }
    await vi.advanceTimersByTimeAsync(20_000);
    for (const client of clients) {
      expect(client.reads).toHaveBeenCalledOnce();
    }
  } finally {
    for (const client of clients) {
      client.sessions.dispose();
      client.selection.dispose();
    }
    vi.useRealTimers();
  }
});
