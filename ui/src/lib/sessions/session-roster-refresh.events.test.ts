// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { session } from "../../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";

describe("session roster event traffic", () => {
  it.each(["snapshot", "active-message", "terminal-message", "invalidation", "filtered"])(
    "bounds requests during a continuous %s stream for existing members",
    async (stream) => {
      vi.useFakeTimers();
      const row = session("main", 1, { sessionId: "tracked", hasActiveRun: true });
      let reads = 0;
      const client = createTestGatewayClient(async (method, params) => {
        expect(method).toBe("sessions.list");
        if (stream === "filtered" && !Reflect.get(params ?? {}, "search")) {
          return sessionsResult([], 0);
        }
        reads += 1;
        if (reads > 1) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
        return sessionsResult([row], reads);
      });
      const gatewayHarness = createGatewayHarness(client);
      const { gateway } = gatewayHarness;
      const sessions = createTestSessionCapability(gateway);
      const query = { agentId: "main", ...(stream === "filtered" ? { search: "tracked" } : {}) };
      const stop = stream === "filtered" ? sessions.subscribeList(query, () => {}) : () => {};
      try {
        await sessions.refreshList({ ...query, force: true });
        for (let index = 0; index < 600; index += 1) {
          gatewayHarness.publishEvent(
            stream.endsWith("-message") ? "session.message" : "sessions.changed",
            {
              sessionKey: row.key,
              agentId: "main",
              phase: "message",
              ...(stream === "invalidation"
                ? {}
                : {
                    session: {
                      ...row,
                      updatedAt: index + 2,
                      totalTokens: index + 1,
                      hasActiveRun: stream !== "terminal-message",
                    },
                  }),
            },
          );
          await vi.advanceTimersByTimeAsync(100);
        }
        console.info(`roster stream=${stream} events/s=10 fetchMs=1000 requests/min=${reads - 1}`);
        if (stream === "snapshot" || stream.endsWith("-message")) {
          expect(reads - 1).toBe(0);
          expect(sessions.state.result?.sessions[0]?.totalTokens).toBe(600);
        } else {
          expect(reads - 1).toBeGreaterThan(1);
          expect(reads - 1).toBeLessThanOrEqual(15);
        }
      } finally {
        stop();
        sessions.dispose();
        await vi.advanceTimersByTimeAsync(1_000);
        vi.useRealTimers();
      }
    },
  );

  it.each([false, true])(
    "rechecks page visibility after background admission (managed: %s)",
    async (managed) => {
      vi.useFakeTimers();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue("visible");
      const row = session("main", 1);
      const query = { agentId: "main", ...(managed ? { search: "tracked" } : {}) };
      const request = vi.fn(async () => sessionsResult([row], 1));
      const client = createTestGatewayClient(request);
      const gatewayHarness = createGatewayHarness(client);
      const { gateway } = gatewayHarness;
      const bootstrap = createConnectionBootstrapCoordinator();
      bootstrap.synchronize({ client, connected: true });
      const sessions = createSessionCapability(
        gateway,
        {
          state: { selectedId: "main" },
          subscribe: () => () => {},
        },
        { connectionBootstrap: bootstrap },
      );
      const stop = managed ? sessions.subscribeList(query, () => {}) : () => {};
      try {
        await sessions.refreshList({ ...query, force: true });
        bootstrap.setForegroundRoute("agent:main:chat");
        gatewayHarness.publishEvent("sessions.changed", { sessionKey: row.key, reason: "patch" });
        await vi.advanceTimersByTimeAsync(200);
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        bootstrap.setForegroundPane({}, { sessionKey: "agent:main:chat", client, ready: true });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(request).toHaveBeenCalledTimes(1);
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(managed ? 3 : 2);
      } finally {
        stop();
        sessions.dispose();
        bootstrap.reset();
        visibility.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["explicit", "filter", "agent", "replacement", "reconnect"])(
    "lets %s refreshes bypass and absorb automatic backoff",
    async (intent) => {
      vi.useFakeTimers();
      let reads = 0;
      const row = session("main", 1);
      const client = createTestGatewayClient(async (method) => {
        if (method !== "sessions.list") {
          return {};
        }
        reads += 1;
        if (reads === 2) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
        return sessionsResult([row], reads);
      });
      const gatewayHarness = createGatewayHarness(client);
      const { gateway } = gatewayHarness;
      const sessions = createTestSessionCapability(gateway);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        gatewayHarness.publishEvent("sessions.changed", { sessionKey: row.key, reason: "patch" });
        await vi.advanceTimersByTimeAsync(1_200);
        expect(reads).toBe(2);
        gatewayHarness.publishEvent("sessions.changed", { sessionKey: row.key, reason: "patch" });
        if (intent === "reconnect") {
          gatewayHarness.publish({ phase: "reconnecting" });
          gatewayHarness.publish({ phase: "connected" });
          await vi.advanceTimersByTimeAsync(0);
        } else if (intent === "replacement") {
          await sessions.refreshReplacement();
        } else {
          await sessions.refresh({
            agentId: intent === "agent" ? "research" : "main",
            ...(intent === "filter" ? { search: "tracked" } : {}),
            force: true,
          });
        }
        expect(reads).toBe(3);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(reads).toBe(3);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["create", "patch", "owner", "archive", "unknown-mutation"])(
    "refreshes authoritative membership for a %s event even with a row snapshot",
    async (reason) => {
      vi.useFakeTimers();
      const row = session("main", 1, { sessionId: "tracked" });
      const request = vi.fn(async () => sessionsResult([row], 1));
      const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
      const { gateway } = gatewayHarness;
      const sessions = createTestSessionCapability(gateway);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        gatewayHarness.publishEvent("sessions.changed", {
          reason,
          sessionKey: row.key,
          session: { ...row, updatedAt: 2 },
        });
        await vi.advanceTimersByTimeAsync(200);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
