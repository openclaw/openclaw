// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createActiveSessionPlacement } from "../../test-helpers/session-placement.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

type Placement = GatewaySessionRow["placement"];
async function createViews(count: number, views: number, active: boolean) {
  vi.useFakeTimers();
  vi.setSystemTime(1);
  const rows: GatewaySessionRow[] = Array.from({ length: count }, (_, index) => ({
    key: `agent:main:placement-${index}`,
    sessionId: `placement-${index}`,
    kind: "direct",
    updatedAt: 1,
    ...(active ? { status: "running" as const, hasActiveRun: true } : {}),
  }));
  const clients = Array.from({ length: views }, () => {
    const counts = { reads: 0, subscribed: 0, bytes: 0 };
    const harness = createSubscriptionHydrationHarness(async (method) => {
      if (method === "sessions.subscribe") {
        counts.subscribed++;
        return { subscribed: true };
      }
      expect(method).toBe("sessions.list");
      counts.reads++;
      const result = sessionsResult(structuredClone(rows), Date.now());
      counts.bytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    });
    return { ...harness, counts };
  });
  onTestFinished(() => {
    clients.forEach((client) => {
      client.sessions.dispose();
      client.selection.dispose();
    });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const publish = (index: number, placement: Placement, invalidation = false) => {
    const session = (rows[index] = { ...rows[index]!, snapshotAt: Date.now(), placement });
    const event = {
      type: "event" as const,
      event: "sessions.changed",
      payload: invalidation
        ? { reason: "runner-availability" }
        : {
            reason: "placement",
            sessionKey: session.key,
            agentId: "main",
            session,
            ancestorSessions: [],
            ts: Date.now(),
          },
    };
    clients.forEach((client) => client.emitEvent(event));
    return Buffer.byteLength(JSON.stringify(event));
  };
  clients.forEach((client) => client.connect());
  await vi.advanceTimersByTimeAsync(0);
  return { rows, clients, publish };
}

it("patches 100 held placement updates across 40 subscribers and reads once on reconnect", async () => {
  const { rows, clients, publish } = await createViews(4, 40, false);
  for (const client of clients) {
    expect(client.counts).toMatchObject({ subscribed: 1, reads: 1 });
    client.counts.reads = 0;
  }
  for (let index = 0; index < 100; index++) {
    publish(
      index % rows.length,
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
    );
    await vi.advanceTimersByTimeAsync(100);
  }
  await vi.advanceTimersByTimeAsync(20_000);
  expect.soft(clients.map((client) => client.counts.reads)).toEqual(Array(40).fill(0));
  for (const client of clients) {
    expect(client.sessions.state.result?.sessions.map((row) => row.placement)).toEqual(
      rows.map((row) => row.placement),
    );
    client.counts.reads = 0;
    client.disconnect();
    client.connect();
  }
  await vi.advanceTimersByTimeAsync(20_000);
  expect(clients.map((client) => client.counts.reads)).toEqual(Array(40).fill(1));
});

it.runIf(process.env.OPENCLAW_DB_WORKER_BENCH === "1").each(["invalidation", "row"] as const)(
  "measures an hour of 60 active sessions across 25 views with %s events",
  async (publication) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { rows, clients, publish } = await createViews(60, 25, true);
    const bootstrap = { ...clients[0]!.counts };
    let eventBytes = 0;
    for (let second = 0; second < 3_600; second++) {
      const index = second % rows.length;
      eventBytes += publish(
        index,
        createActiveSessionPlacement({
          environmentId: `environment-${index}`,
          workspaceBaseManifestRef: "synthetic-manifest",
          runner: {
            kind: "device",
            deviceId: `device-${index}`,
            status: Math.floor(second / rows.length) % 2 ? "available" : "offline",
          },
        }),
        publication === "invalidation",
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const metrics = clients.map(({ counts }) => ({
      fullReads: counts.reads - bootstrap.reads,
      responseBytes: counts.bytes - bootstrap.bytes,
      eventBytes,
      totalBytes: counts.bytes - bootstrap.bytes + eventBytes,
    }));
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
  },
  120_000,
);
