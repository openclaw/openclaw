// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { SessionActivityController } from "../../pages/activity/session-activity-controller.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentCapability } from "../agents/index.ts";
import { rosterActivityStore } from "../agents/roster-activity-store.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";

it("bounds list reads across two viewers and three streaming sessions for three minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1);
  let trigger = "route";
  const rows: GatewaySessionRow[] = Array.from({ length: 3 }, (_, index) => ({
    key: `agent:main:stream-${index}`,
    kind: "direct",
    sessionId: `stream-${index}`,
    updatedAt: 1,
    hasActiveRun: true,
    status: "running",
  }));
  const viewers = Array.from({ length: 2 }, () => {
    const reads: Record<string, number> = {};
    const client = createTestGatewayClient(async (method, params) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "agents.list") {
        return {
          agents: [{ id: "main" }],
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
        };
      }
      expect(method).toBe("sessions.list");
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
    });
    const source = createApplicationGateway({
      client,
      phase: "connected",
      hello: null,
      offlineStable: false,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: rows[0]!.key,
      lastError: null,
      lastErrorCode: null,
    });
    const sessions = createTestSessionCapability(source.gateway);
    const agents = createAgentCapability(source.gateway);
    const store = rosterActivityStore({
      gateway: source.gateway,
      agents,
      agentIdentity: {
        get: () => null,
        entries: () => [],
        ensure: async () => {},
        invalidate: () => {},
        subscribe: () => () => {},
      },
    });
    const stop = store.subscribe(() => {});
    const activity = new SessionActivityController({
      addController() {},
      removeController() {},
      requestUpdate() {},
      updateComplete: Promise.resolve(true),
    });
    void sessions.refresh({ agentId: "main", force: true });
    void activity.load(client, { personId: null, time: "all", query: "" });
    return { reads, sessions, store, activity, stop, source, client, agents };
  });
  try {
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
    console.log("session-refetch-volume", JSON.stringify(viewers.map(({ reads }) => reads)));
    expect(viewers[0]!.reads).toEqual(viewers[1]!.reads);
    for (const { reads, sessions, store } of viewers) {
      expect(reads["sidebar:session.message"] ?? 0).toBe(0);
      expect(reads["roster:session.message"] ?? 0).toBe(0);
      expect(reads["sidebar:patch"] ?? 0).toBe(0);
      expect(reads["roster:patch"] ?? 0).toBe(0);
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
    await vi.advanceTimersByTimeAsync(0);
    for (const { reads } of viewers) {
      expect(reads["activity:route-change"]).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    for (const { reads } of viewers) {
      expect(reads["activity:route-change"]).toBe(1);
    }
  } finally {
    for (const { sessions, activity, stop, agents } of viewers) {
      stop();
      sessions.dispose();
      activity.hostDisconnected();
      agents.dispose();
    }
    vi.useRealTimers();
  }
});
