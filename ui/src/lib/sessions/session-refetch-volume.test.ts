// @vitest-environment node
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { createSessionActivity } from "../../pages/activity/session-activity-owner.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentCapability } from "../agents/index.ts";
import { rosterActivityStore } from "../agents/roster-activity-store.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";
import { gatewayRequest, sessionRow } from "./session-fixtures.test-support.ts";

it("bounds list reads across two viewers and three streaming sessions for three minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1);
  const cleanup: Array<() => void> = [() => vi.useRealTimers()];
  onTestFinished(() => cleanup.toReversed().forEach((stop) => stop()));
  let trigger = "route";
  const rows = Array.from({ length: 3 }, (_, index) =>
    sessionRow(`agent:main:stream-${index}`, {
      sessionId: `stream-${index}`,
      hasActiveRun: true,
      status: "running",
    }),
  );
  const viewers = Array.from({ length: 2 }, () => {
    const reads: Record<string, number> = {};
    const client = createTestGatewayClient(
      gatewayRequest({
        "sessions.subscribe": () => ({ subscribed: true }),
        "agents.list": () => ({
          agents: [{ id: "main" }],
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
        }),
        "sessions.list": (params) => {
          const query = params as { includeActivitySummary?: boolean; archived?: string };
          const owner = query.includeActivitySummary
            ? "activity"
            : query.archived
              ? "roster"
              : "sidebar";
          const key = `${owner}:${trigger}`;
          reads[key] = (reads[key] ?? 0) + 1;
          return sessionsResult(
            rows.map((row) => ({ ...row })),
            Date.now(),
          );
        },
      }),
    );
    const source = createApplicationGateway();
    source.publish({
      ...source.gateway.snapshot,
      client,
      phase: "connected",
      assistantAgentId: "main",
      sessionKey: rows[0]!.key,
    });
    const sessions = createTestSessionCapability(source.gateway);
    const agents = createAgentCapability(source.gateway);
    const store = rosterActivityStore({
      gateway: source.gateway,
      sessions,
      agents,
      agentIdentity: {
        get: () => null,
        entries: () => [],
        ensure: async () => {},
        invalidate: () => {},
        subscribe: () => () => {},
      },
    });
    cleanup.push(() => agents.dispose());
    const stop = store.subscribe(() => {});
    const activity = createSessionActivity(() => {});
    cleanup.push(
      () => activity.dispose(),
      () => sessions.dispose(),
      stop,
    );
    void sessions.refresh({ agentId: "main", force: true });
    void activity.load(client, { personId: null, time: "all", query: "" });
    return { reads, sessions, store, activity, source, client };
  });
  await vi.advanceTimersByTimeAsync(0);
  for (const phase of ["session.message", "patch", "stores"]) {
    trigger = phase;
    for (let second = 0; second < 60; second += 1) {
      for (const row of rows) {
        row.updatedAt = Date.now();
        const event: GatewayEventFrame = {
          type: "event",
          event: phase === "session.message" ? "session.message" : "sessions.changed",
          payload:
            phase === "stores"
              ? { reason: "stores" }
              : {
                  ...(phase === "patch" ? { reason: "patch" } : {}),
                  sessionKey: row.key,
                  session: { ...row },
                },
        };
        for (const viewer of viewers) {
          viewer.source.publishEvent(event);
          // Activity's sessions route subscribes to sessions.changed, not streaming messages.
          if (event.event === "sessions.changed") {
            viewer.activity.invalidate(event.payload);
          }
        }
      }
      await vi.advanceTimersByTimeAsync(1_000);
    }
  }
  expect(viewers[0]!.reads).toEqual(viewers[1]!.reads);
  for (const { reads, sessions, store } of viewers) {
    for (const owner of ["sidebar", "roster"]) {
      expect([reads[`${owner}:session.message`] ?? 0, reads[`${owner}:patch`] ?? 0]).toEqual([
        0, 0,
      ]);
    }
    expect(reads["activity:patch"]).toBeLessThanOrEqual(12);
    for (const owner of ["sidebar", "roster", "activity"]) {
      expect(reads[`${owner}:stores`]).toBeLessThanOrEqual(12);
    }
    expect(sessions.state.result?.sessions).toHaveLength(3);
    expect(store.snapshot.result?.sessions).toHaveLength(3);
  }
  trigger = "route-change";
  for (const { activity, client } of viewers) {
    activity.invalidate();
    void activity.load(client, { personId: "another-person", time: "all", query: "" });
  }
  for (const delay of [0, 20_000]) {
    await vi.advanceTimersByTimeAsync(delay);
    for (const { reads } of viewers) {
      expect(reads["activity:route-change"]).toBe(1);
    }
  }
});
