// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "./session-capability.test-support.ts";

type Placement = GatewaySessionRow["placement"];
async function createViews(count: number, views: number) {
  vi.useFakeTimers();
  vi.setSystemTime(1);
  const rows: GatewaySessionRow[] = Array.from({ length: count }, (_, index) => ({
    key: `agent:main:placement-${index}`,
    sessionId: `placement-${index}`,
    kind: "direct",
    updatedAt: 1,
  }));
  const clients = Array.from({ length: views }, () => {
    const counts = { reads: 0, subscribed: 0 };
    const harness = createSubscriptionHydrationHarness(async (method) => {
      if (method === "sessions.subscribe") {
        counts.subscribed++;
        return { subscribed: true };
      }
      expect(method).toBe("sessions.list");
      counts.reads++;
      return sessionsResult(structuredClone(rows), Date.now());
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
  const publish = (index: number, placement: Placement) => {
    const session = (rows[index] = { ...rows[index]!, snapshotAt: Date.now(), placement });
    const event = {
      type: "event" as const,
      event: "sessions.changed",
      payload: {
        reason: "placement",
        sessionKey: session.key,
        agentId: "main",
        session,
        ancestorSessions: [],
        ts: Date.now(),
      },
    };
    clients.forEach((client) => client.emitEvent(event));
  };
  clients.forEach((client) => client.connect());
  await vi.advanceTimersByTimeAsync(0);
  return { rows, clients, publish };
}

it("patches 100 held placement updates across 40 subscribers and reads once on reconnect", async () => {
  const { rows, clients, publish } = await createViews(4, 40);
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
