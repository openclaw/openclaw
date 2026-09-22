// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { session } from "../../test-helpers/app-sidebar-cases/roster.test-support.ts";
import { createGatewayHarness } from "../../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import { createTestSessionCapability, sessionsResult } from "./session-capability.test-support.ts";

describe("session roster event traffic", () => {
  it.each([false, true])(
    "recovers failed membership refreshes on the next keyed snapshot (managed: %s)",
    async (managed) => {
      vi.useFakeTimers();
      const held = session("main", 1, { sessionId: "held" });
      const updated = { ...held, updatedAt: 2 };
      const added = session("main", 3, { key: "agent:main:new", sessionId: "new" });
      let rows = [held];
      let fail = false;
      let reads = 0;
      const client = createTestGatewayClient(async (_method, params) => {
        const selected = (Reflect.get(params ?? {}, "archived") === "all") === managed;
        if (selected) {
          reads += 1;
          if (fail) {
            throw new Error("List unavailable");
          }
        }
        return sessionsResult(rows, 1);
      });
      const harness = createGatewayHarness(client);
      const sessions = createTestSessionCapability(harness.gateway);
      const query = { agentId: "main", ...(managed ? { archivedFilter: "all" as const } : {}) };
      const stop = managed ? sessions.subscribeList(query, () => {}) : () => {};
      try {
        await sessions.refresh({ agentId: "main", force: true });
        if (managed) {
          await sessions.refreshList(query);
        }
        fail = true;
        harness.publishEvent("sessions.changed", { reason: "stores" });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(sessions.listSnapshot(query).error).toBe("List unavailable");
        fail = false;
        rows = [added, updated];
        harness.publishEvent("sessions.changed", { reason: "patch", session: updated });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(reads).toBe(3);
        expect(sessions.listSnapshot(query).error).toBeNull();
        expect(sessions.listSnapshot(query).result?.sessions).toEqual(rows);
      } finally {
        stop();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["child", "parent"])(
    "refreshes related parent facts when lineage is recorded on the %s row",
    async (lineage) => {
      vi.useFakeTimers();
      const parent = session("main", 10, {
        key: "agent:main:parent",
        sessionId: "parent",
        hasActiveSubagentRun: true,
        ...(lineage === "parent" ? { childSessions: ["agent:main:child"] } : {}),
      });
      const child = session("main", 20, {
        key: "agent:main:child",
        sessionId: "child",
        hasActiveRun: true,
        ...(lineage === "child" ? { spawnedBy: parent.key } : {}),
      });
      const stopped = { ...child, hasActiveRun: false, updatedAt: 30 };
      const finalRows = [stopped, { ...parent, hasActiveSubagentRun: false }];
      const request = vi
        .fn()
        .mockResolvedValueOnce(sessionsResult([child, parent], 1))
        .mockResolvedValue(sessionsResult(finalRows, 2));
      const harness = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(harness.gateway);
      try {
        await sessions.refresh({ agentId: "main", force: true });
        harness.publishEvent("sessions.changed", { reason: "patch", session: stopped });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.state.result?.sessions).toEqual(finalRows);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each(["enter", "unpin", "archive", "owner-prefix"])(
    "refills a limited window after %s changes its boundary",
    async (change) => {
      vi.useFakeTimers();
      const held = session("main", change === "unpin" || change === "owner-prefix" ? 10 : 40, {
        key: "agent:main:held",
        sessionId: "held",
        ...(change === "unpin" ? { pinned: true, pinnedAt: 5 } : {}),
      });
      const recent = session("main", 30, { key: "agent:main:recent", sessionId: "recent" });
      const boundary = session("main", 20, { key: "agent:main:boundary", sessionId: "boundary" });
      const incoming = session("main", 50, { key: "agent:main:incoming", sessionId: "incoming" });
      const next =
        change === "enter"
          ? incoming
          : {
              ...held,
              updatedAt: change === "owner-prefix" ? 50 : held.updatedAt,
              ...(change === "unpin" ? { pinned: false, pinnedAt: undefined } : {}),
              ...(change === "archive" ? { archived: true } : {}),
            };
      const initialRows = change === "owner-prefix" ? [held, recent, boundary] : [held, recent];
      const finalRows =
        change === "enter"
          ? [next, held]
          : change === "owner-prefix"
            ? [next, recent]
            : [recent, boundary];
      const page = (rows: typeof initialRows) => ({
        ...sessionsResult(rows, 1),
        totalCount: 4,
        limitApplied: 2,
        nextOffset: 2,
        hasMore: true,
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce(page(initialRows))
        .mockResolvedValue(page(finalRows));
      const gatewayHarness = createGatewayHarness(createTestGatewayClient(request));
      const sessions = createTestSessionCapability(gatewayHarness.gateway);
      try {
        await sessions.refresh({
          agentId: "main",
          limit: 2,
          ownerFirst: change === "owner-prefix",
          force: true,
        });
        for (let index = 0; index < 10; index += 1) {
          gatewayHarness.publishEvent("sessions.changed", {
            reason: "patch",
            sessionKey: next.key,
            pinnedAt: null,
            session: next,
          });
        }
        await vi.advanceTimersByTimeAsync(20_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.state.result?.sessions).toEqual(finalRows);
        expect(sessions.state.result).toMatchObject({ hasMore: true, nextOffset: 2, count: 2 });
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "snapshot",
    "patch",
    "send",
    "steer",
    "agent.run.started",
    "agent.input.settled",
    "run-capacity",
    "chat.title",
    "active-message",
    "terminal-message",
    "invalidation",
    "filtered",
    "all",
  ])("bounds requests during a continuous %s stream for existing members", async (stream) => {
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
    const query = {
      agentId: "main",
      ...(stream === "filtered" ? { search: "tracked" } : {}),
      ...(stream === "all" ? { archivedFilter: "all" as const } : {}),
    };
    const stop = ["filtered", "all"].includes(stream)
      ? sessions.subscribeList(query, () => {})
      : () => {};
    try {
      if (stream === "all") {
        await sessions.refresh({ agentId: "main", force: true });
      }
      const initial = sessions.refreshList({ ...query, force: true });
      if (stream === "all") {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      await initial;
      const initialReads = reads;
      for (let index = 0; index < 600; index += 1) {
        gatewayHarness.publishEvent(
          stream.endsWith("-message") ? "session.message" : "sessions.changed",
          {
            sessionKey: row.key,
            agentId: "main",
            phase: "message",
            ...([
              "patch",
              "send",
              "steer",
              "agent.run.started",
              "agent.input.settled",
              "run-capacity",
              "chat.title",
            ].includes(stream)
              ? { reason: stream }
              : {}),
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
      console.info(
        `roster stream=${stream} events/s=10 fetchMs=1000 requests/min=${reads - initialReads}`,
      );
      if (stream !== "invalidation" && stream !== "filtered") {
        expect(reads - initialReads).toBe(0);
        expect(sessions.listSnapshot(query).result?.sessions[0]?.totalTokens).toBe(600);
      } else {
        expect(reads - initialReads).toBeGreaterThan(1);
        expect(reads - initialReads).toBeLessThanOrEqual(15);
      }
    } finally {
      stop();
      sessions.dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
    }
  });

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
        await vi.advanceTimersByTimeAsync(5_000);
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
        await vi.advanceTimersByTimeAsync(6_000);
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

  it.each(["create", "owner", "archive", "unknown-mutation"])(
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
        await vi.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
