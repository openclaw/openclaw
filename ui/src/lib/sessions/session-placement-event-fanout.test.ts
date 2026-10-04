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

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1").each(["invalidation", "row"] as const)(
  "measures an hour of 60 active sessions across 25 views with %s events",
  async (publication) => {
    vi.useFakeTimers();
    vi.setSystemTime(1);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const rows: GatewaySessionRow[] = Array.from({ length: 60 }, (_, index) => ({
      key: `agent:main:placement-${index}`,
      sessionId: `placement-${index}`,
      kind: "direct",
      updatedAt: 1,
      status: "running",
      hasActiveRun: true,
    }));
    const clients = Array.from({ length: 25 }, () => {
      let reads = 0;
      let bytes = 0;
      const harness = createSubscriptionHydrationHarness(async (method) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        expect(method).toBe("sessions.list");
        const result = sessionsResult(structuredClone(rows), Date.now());
        reads++;
        bytes += Buffer.byteLength(JSON.stringify(result));
        return result;
      });
      return { ...harness, metrics: () => ({ reads, bytes }) };
    });
    try {
      clients.forEach((client) => client.connect());
      await vi.advanceTimersByTimeAsync(0);
      const bootstrap = clients[0]!.metrics();
      let eventBytes = 0;
      for (let second = 0; second < 3_600; second++) {
        const index = second % rows.length;
        const row = rows[index]!;
        rows[index] = {
          ...row,
          snapshotAt: Date.now(),
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            stateChangedAtMs: 1,
            environmentId: `environment-${index}`,
            runner: {
              kind: "device",
              deviceId: `device-${index}`,
              status: Math.floor(second / rows.length) % 2 ? "available" : "offline",
            },
          },
        };
        const event = {
          type: "event" as const,
          event: "sessions.changed",
          payload:
            publication === "invalidation"
              ? { reason: "runner-availability" }
              : {
                  reason: "placement",
                  sessionKey: row.key,
                  agentId: "main",
                  session: rows[index],
                  ancestorSessions: [],
                  ts: Date.now(),
                },
        };
        eventBytes += Buffer.byteLength(JSON.stringify(event));
        clients.forEach((client) => client.emitEvent(event));
        await vi.advanceTimersByTimeAsync(1_000);
      }
      const metrics = clients.map((client) => {
        const result = client.metrics();
        return {
          fullReads: result.reads - bootstrap.reads,
          responseBytes: result.bytes - bootstrap.bytes,
          eventBytes,
          totalBytes: result.bytes - bootstrap.bytes + eventBytes,
        };
      });
      expect(metrics.every((metric) => metric.fullReads === metrics[0]!.fullReads)).toBe(true);
      if (publication === "row") {
        expect(metrics[0]!.fullReads).toBeLessThanOrEqual(60);
      }
      expect(clients[0]!.sessions.state.result?.sessions).toHaveLength(60);
      console.log(
        JSON.stringify({
          publication,
          connections: 25,
          sessions: 60,
          seconds: 3_600,
          ...metrics[0],
        }),
      );
    } finally {
      clients.forEach((client) => {
        client.sessions.dispose();
        client.selection.dispose();
      });
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  },
);
