import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { importSessionCatalogHistory } from "../plugins/session-catalog-history-import.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { listSessionStateEventsSince, registerSessionStateWatch } from "./session-state-events.js";
import * as upstreamRuntime from "./session-upstream-links-runtime.js";
import * as upstreamLinks from "./session-upstream-links.js";
import { deleteSessionUpstreamLink, upsertSessionUpstreamLink } from "./session-upstream-links.js";
import { readSessionUpstreamLinkInDatabase } from "./session-upstream-links.kernel.js";
import { startSessionUpstreamMonitor } from "./session-upstream-monitor.js";
import {
  mockEntry,
  mockOwnTexts,
  mockRunActive,
  runSessionUpstreamMonitorTick,
} from "./session-upstream-monitor.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-upstream-monitor-");
const watcherSessionKey = "agent:main:main";

function createMissingCounts() {
  return new Map<string, { count: number; linkUpdatedAt: number }>();
}

function createDatabaseOptions() {
  const stateDir = sessionDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({});
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

async function createLink(
  sessionKey: string,
  catalogId: string,
  database: ReturnType<typeof createDatabaseOptions>,
  watched = true,
) {
  upsertSessionUpstreamLink(
    {
      sessionKey,
      agentId: "main",
      catalogId,
      hostId: "gateway:local",
      threadId: `thread-${catalogId}`,
      upstreamKind: catalogId === "claude" ? "claude-cli" : "codex-app-server",
      upstreamRef: { source: catalogId },
      marker: { offset: 0 },
    },
    database,
  );
  if (watched) {
    await registerSessionStateWatch({ watcherSessionKey, targetSessionKey: sessionKey }, database);
  }
}

function readLink(database: ReturnType<typeof createDatabaseOptions>, sessionKey: string) {
  return readSessionUpstreamLinkInDatabase(
    openOpenClawStateDatabase(database).db,
    sessionKey,
    "main",
  );
}

async function events(database: ReturnType<typeof createDatabaseOptions>, sessionKey: string) {
  return (await listSessionStateEventsSince(sessionKey, "main", 0, 20, database)).events;
}

function provider(
  id: string,
  checkUpstreamActivity: NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>,
): SessionCatalogProvider {
  return {
    id,
    label: id,
    list: async () => [],
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    checkUpstreamActivity,
  };
}

function monitorOptions(
  database: ReturnType<typeof createDatabaseOptions>,
  check: NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>,
) {
  mockOwnTexts();
  return {
    ...database,
    providers: [provider("claude", check)],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("session upstream monitor", () => {
  it("skips watched-link reads without a capable provider and reads fresh links when one appears", async () => {
    const database = createDatabaseOptions();
    const list = vi.spyOn(upstreamLinks, "listWatchedSessionUpstreamLinks");
    const missingCounts = createMissingCounts();
    missingCounts.set("old-watch", { count: 2, linkUpdatedAt: 100 });
    try {
      await runSessionUpstreamMonitorTick({ ...database, providers: [] }, missingCounts);
      expect(list).not.toHaveBeenCalled();
      expect(missingCounts.size).toBe(0);

      const sessionKey = "agent:main:adopted:new-provider";
      await createLink(sessionKey, "claude", database);
      const check = vi.fn(async () => []);
      mockEntry(async () => ({ sessionId: "new-provider", updatedAt: 100 }));
      mockRunActive(() => false);
      await runSessionUpstreamMonitorTick(monitorOptions(database, check));
      expect(list).toHaveBeenCalledOnce();
      expect(check).toHaveBeenCalledWith(
        [expect.objectContaining({ sessionKey })],
        expect.anything(),
      );
    } finally {
      list.mockRestore();
    }
  });

  it("discards discovery after the monitor is aborted", async () => {
    const database = createDatabaseOptions();
    await createLink("agent:main:adopted:aborted-discovery", "claude", database);
    const lifecycle = new AbortController();
    const loadEntry = mockEntry(async () => ({ sessionId: "session-aborted", updatedAt: 100 }));
    const check = vi.fn(async () => []);
    const missingCounts = createMissingCounts();
    missingCounts.set("previous-watch", { count: 2, linkUpdatedAt: 100 });
    mockRunActive(() => false);
    mockOwnTexts();
    const tick = runSessionUpstreamMonitorTick(
      {
        ...database,
        signal: lifecycle.signal,
        providers: [provider("claude", check)],
      },
      missingCounts,
    );
    lifecycle.abort();
    await tick;

    expect(loadEntry).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect([...missingCounts]).toEqual([["previous-watch", { count: 2, linkUpdatedAt: 100 }]]);
  });

  it("continues the provider batch when one marker settlement loses its owner", async () => {
    const database = createDatabaseOptions();
    const stale = "agent:main:adopted:a-stale";
    const healthy = "agent:main:adopted:b-healthy";
    await createLink(stale, "claude", database);
    await createLink(healthy, "claude", database);
    const settlement = vi
      .spyOn(upstreamRuntime, "settleSessionUpstreamLink")
      .mockRejectedValueOnce(new Error("Upstream observation lost its idle session owner"));
    try {
      mockEntry(async ({ sessionKey }) => ({ sessionId: sessionKey, updatedAt: 1_000 }));
      mockOwnTexts();
      await runSessionUpstreamMonitorTick({
        ...database,
        providers: [
          provider("claude", async (probes) =>
            probes.map((probe) => ({
              kind: "activity",
              sessionKey: probe.sessionKey,
              humanTurns: 0,
              nextMarker: { offset: 9 },
              dedupeId: "none",
            })),
          ),
        ],
      });
    } finally {
      settlement.mockRestore();
    }
    expect(readLink(database, stale)?.marker).toEqual({ offset: 0 });
    expect(readLink(database, healthy)?.marker).toEqual({ offset: 9 });
  });

  it("keeps the upstream marker available when its durable event insert fails", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:failed-event";
    await createLink(sessionKey, "claude", database);
    openOpenClawStateDatabase(database).db.exec(`
      CREATE TRIGGER reject_upstream_event BEFORE INSERT ON session_state_events
      BEGIN SELECT RAISE(FAIL, 'synthetic event write failure'); END;
    `);
    mockEntry(async () => ({ sessionId: "session-failed-event", updatedAt: 1_000 }));
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => [
          {
            kind: "activity",
            sessionKey,
            humanTurns: 1,
            occurredAt: 2_000,
            nextMarker: { offset: 9 },
            dedupeId: "failed-event",
          },
        ]),
      ],
    });
    expect(readLink(database, sessionKey)?.marker).toEqual({ offset: 0 });
    expect(await events(database, sessionKey)).toEqual([]);
  });

  it("records watched activity once and advances its marker without host SQL", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:watched";
    const unwatched = "agent:main:adopted:unwatched";
    await createLink(watched, "claude", database);
    await createLink(unwatched, "claude", database, false);
    const checkUpstreamActivity = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_000,
        humanTurns: 1,
        nextMarker: { offset: 8 },
        dedupeId: "8",
      })),
    );
    const claude = provider("claude", checkUpstreamActivity);
    await upsertSessionEntryCore(
      { sessionKey: watched, agentId: "main", env: database.env },
      { sessionId: "session-watched", updatedAt: 100 },
    );
    const hostSql = observeMainThreadSql();
    try {
      for (const now of [3_000, 4_000]) {
        mockOwnTexts();
        await runSessionUpstreamMonitorTick({
          ...database,
          providers: [claude],
          now: () => now,
        });
      }
      hostSql.expectIdle();
    } finally {
      hostSql.restore();
    }

    expect(checkUpstreamActivity).toHaveBeenCalledTimes(2);
    expect(checkUpstreamActivity).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ sessionKey: watched, marker: { offset: 0 } })],
      { allowProcessHomeFallback: false },
    );
    expect(checkUpstreamActivity).toHaveBeenNthCalledWith(
      2,
      [expect.objectContaining({ sessionKey: watched, marker: { offset: 8 } })],
      { allowProcessHomeFallback: false },
    );
    const recordedEvents = (await listSessionStateEventsSince(watched, "main", 0, 20, database))
      .events;
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]).toEqual(
      expect.objectContaining({
        kind: "human_direct_message",
        summary: "human message via claude",
        occurredAt: 2_000,
      }),
    );
    expect(recordedEvents[0]?.payload).toBeUndefined();
    const dedupeRow = openOpenClawStateDatabase(database)
      .db.prepare("SELECT dedupe_key FROM session_state_events WHERE session_key = ?")
      .get(watched) as { dedupe_key: string };
    // Source identity is hashed into the dedupe key so a rebased source cannot
    // collide with a prior source's activity id.
    expect(dedupeRow.dedupe_key).toMatch(new RegExp(`^upstream:${watched}:[0-9a-f]{16}:8$`));
  });

  it("records one upstream-missing event after three misses and removes the link", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing";
    await createLink(sessionKey, "claude", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({ kind: "missing" as const, sessionKey: probe.sessionKey })),
    );
    mockEntry(async () => ({ sessionId: "session-missing", updatedAt: 0 }));
    mockOwnTexts();
    const options = {
      ...database,
      providers: [provider("claude", check)],
      now: () => 3_000,
    };
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(check).toHaveBeenCalledTimes(3);
    expect(
      readSessionUpstreamLinkInDatabase(openOpenClawStateDatabase(database).db, sessionKey, "main"),
    ).toBeUndefined();
    expect(missingCounts.size).toBe(0);
    expect((await listSessionStateEventsSince(sessionKey, "main", 0, 20, database)).events).toEqual(
      [
        expect.objectContaining({
          kind: "upstream_missing",
          actorType: "system",
          summary: "upstream missing via claude",
          payload: { channel: "claude" },
        }),
      ],
    );
  });

  it("defers a third missing result when a run starts during the provider scan", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-active-race";
    await createLink(sessionKey, "claude", database);
    let active = false;
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      if (scan === 3) {
        active = true;
      }
      return [{ kind: "missing" as const, sessionKey }];
    });
    mockEntry(async () => ({ sessionId: "session-missing-active-race", updatedAt: 0 }));
    mockRunActive(() => active);
    const options = monitorOptions(database, check);
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(readLink(database, sessionKey)).toBeDefined();
    expect(await events(database, sessionKey)).toEqual([]);
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([2]);

    active = false;
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(check).toHaveBeenCalledTimes(4);
    expect(readLink(database, sessionKey)).toBeUndefined();
    expect(await events(database, sessionKey)).toEqual([
      expect.objectContaining({ kind: "upstream_missing" }),
    ]);
  });

  it("resets a missing streak when the session is replaced during the provider scan", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-session-replaced";
    await createLink(sessionKey, "claude", database);
    let sessionId = "session-before";
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      if (scan === 3) {
        sessionId = "session-after";
      }
      return [{ kind: "missing" as const, sessionKey }];
    });
    mockEntry(async () => ({ sessionId, updatedAt: 0 }));
    mockRunActive(() => false);
    const options = monitorOptions(database, check);
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(missingCounts.size).toBe(0);
    expect(readLink(database, sessionKey)).toBeDefined();
    expect(await events(database, sessionKey)).toEqual([]);

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([2]);
    expect(readLink(database, sessionKey)).toBeDefined();
  });

  it.each(["monitor", "scheduler"])(
    "joins a deferred probe without publication after %s stop",
    async (stopOwner) => {
      const clock = createGatewaySchedulerClock(1_000);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const database = createDatabaseOptions();
      const sessionKey = "agent:main:adopted:missing-stopped";
      await createLink(sessionKey, "claude", database);
      const thirdResult = createDeferred<Array<{ kind: "missing"; sessionKey: string }>>();
      const scanStarted = [createDeferred(), createDeferred(), createDeferred()] as const;
      let scan = 0;
      let probeSettled = false;
      const check = vi.fn(async () => {
        scan += 1;
        scanStarted[scan - 1]?.resolve();
        if (scan === 3) {
          const result = await thirdResult.promise;
          probeSettled = true;
          return result;
        }
        return [{ kind: "missing" as const, sessionKey }];
      });
      mockEntry(async () => ({ sessionId: "session-missing-stopped", updatedAt: 1_000 }));
      mockRunActive(() => false);
      mockOwnTexts();
      const monitor = startSessionUpstreamMonitor({
        scheduler,
        ...database,
        providers: [provider("claude", check)],
      });

      try {
        await clock.advanceBy(15_000);
        await scanStarted[0].promise;
        await clock.advanceBy(45_000);
        await scanStarted[1].promise;
        const thirdWake = clock.advanceBy(60_000);
        await scanStarted[2].promise;
        expect(check).toHaveBeenCalledTimes(3);

        let joined = false;
        const stopping = (stopOwner === "scheduler" ? scheduler.stop() : monitor.stop()).then(
          () => {
            expect(probeSettled).toBe(true);
            joined = true;
          },
        );
        expect(joined).toBe(false);
        thirdResult.resolve([{ kind: "missing", sessionKey }]);
        await stopping;
        await thirdWake;

        expect(readLink(database, sessionKey)).toMatchObject({
          marker: { offset: 0 },
        });
        expect(await events(database, sessionKey)).toEqual([]);
        if (stopOwner === "monitor") {
          const sibling = vi.fn();
          scheduler.schedule({ id: "sibling", delayMs: 1, run: sibling });
          await clock.advanceBy(60_000);
          expect(sibling).toHaveBeenCalledOnce();
          expect(check).toHaveBeenCalledTimes(3);
        }
      } finally {
        thirdResult.resolve([]);
        await monitor.stop();
        await scheduler.stop();
      }
    },
  );

  it("resets consecutive misses on activity", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-reset";
    await createLink(sessionKey, "claude", database);
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      return scan === 3
        ? [
            {
              kind: "activity" as const,
              sessionKey,
              humanTurns: 0,
              nextMarker: { offset: 3 },
            },
          ]
        : [{ kind: "missing" as const, sessionKey }];
    });
    mockEntry(async () => ({ sessionId: "session-missing-reset", updatedAt: 0 }));
    mockOwnTexts();
    const options = {
      ...database,
      providers: [provider("claude", check)],
    };
    const missingCounts = createMissingCounts();

    for (let index = 0; index < 5; index += 1) {
      await runSessionUpstreamMonitorTick(options, missingCounts);
    }

    expect(check).toHaveBeenCalledTimes(5);
    expect((await listSessionStateEventsSince(sessionKey, "main", 0, 20, database)).events).toEqual(
      [],
    );
    expect(
      readSessionUpstreamLinkInDatabase(openOpenClawStateDatabase(database).db, sessionKey, "main"),
    ).toBeDefined();
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([2]);
  });

  it("breaks a missing streak when a successful probe has no missing outcome", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-quiet";
    await createLink(sessionKey, "claude", database);
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      return scan === 2 ? [] : [{ kind: "missing" as const, sessionKey }];
    });
    mockEntry(async () => ({ sessionId: "session-missing-quiet", updatedAt: 0 }));
    mockOwnTexts();
    const options = {
      ...database,
      providers: [provider("claude", check)],
    };
    const missingCounts = createMissingCounts();

    for (let index = 0; index < 4; index += 1) {
      await runSessionUpstreamMonitorTick(options, missingCounts);
    }

    expect((await listSessionStateEventsSince(sessionKey, "main", 0, 20, database)).events).toEqual(
      [],
    );
    expect(
      readSessionUpstreamLinkInDatabase(openOpenClawStateDatabase(database).db, sessionKey, "main"),
    ).toBeDefined();
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([2]);
  });

  it("starts a fresh streak when Continue refreshes the same source", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-same-source";
    await createLink(sessionKey, "claude", database);
    const check = vi.fn(async () => [{ kind: "missing" as const, sessionKey }]);
    mockEntry(async () => ({ sessionId: "session-missing-same-source", updatedAt: 0 }));
    mockOwnTexts();
    const options = {
      ...database,
      providers: [provider("claude", check)],
    };
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    upsertSessionUpstreamLink(
      {
        sessionKey,
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-claude",
        upstreamKind: "claude-cli",
        upstreamRef: { source: "claude" },
        marker: { offset: 0 },
      },
      { ...database, now: 7_777 },
    );
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect((await listSessionStateEventsSince(sessionKey, "main", 0, 20, database)).events).toEqual(
      [],
    );
    expect(
      readSessionUpstreamLinkInDatabase(openOpenClawStateDatabase(database).db, sessionKey, "main"),
    ).toBeDefined();
    expect([...missingCounts.values()].map((counter) => counter.count)).toEqual([1]);
  });

  it("aborts missing record and deletion when Continue changes the source", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-refreshed";
    await createLink(sessionKey, "claude", database);
    let scan = 0;
    const check = vi.fn(async () => {
      scan += 1;
      if (scan === 3) {
        upsertSessionUpstreamLink(
          {
            sessionKey,
            agentId: "main",
            catalogId: "claude",
            hostId: "gateway:local",
            threadId: "thread-refreshed",
            upstreamKind: "claude-cli",
            upstreamRef: { source: "refreshed" },
            marker: { offset: 999 },
          },
          { ...database, now: 7_777 },
        );
      }
      return [{ kind: "missing" as const, sessionKey }];
    });
    mockEntry(async () => ({ sessionId: "session-missing-refreshed", updatedAt: 0 }));
    const options = monitorOptions(database, check);
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(await events(database, sessionKey)).toEqual([]);
    expect(readLink(database, sessionKey)).toEqual(
      expect.objectContaining({ threadId: "thread-refreshed", marker: { offset: 999 } }),
    );
  });

  it("prunes missing counters when a link leaves the watched set", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:missing-pruned";
    await createLink(sessionKey, "claude", database);
    const check = vi.fn(async () => [{ kind: "missing" as const, sessionKey }]);
    mockEntry(async () => ({ sessionId: "session-missing-pruned", updatedAt: 0 }));
    const options = monitorOptions(database, check);
    const missingCounts = createMissingCounts();

    await runSessionUpstreamMonitorTick(options, missingCounts);
    expect(missingCounts.size).toBe(1);
    deleteSessionUpstreamLink(sessionKey, "main", database);
    await runSessionUpstreamMonitorTick(options, missingCounts);

    expect(check).toHaveBeenCalledOnce();
    expect(missingCounts.size).toBe(0);
  });

  it("clamps skewed upstream event times without touching bookkeeping clocks", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:clamped";
    await createLink(watched, "claude", database);
    const now = 100 * 24 * 60 * 60_000;
    const ancient = 1_000; // far beyond the 24h clamp window
    const claude = provider("claude", async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: ancient,
        humanTurns: 1,
        nextMarker: { offset: 4 },
        dedupeId: "4",
      })),
    );

    mockEntry(async () => ({ sessionId: "session-clamped", updatedAt: 0 }));
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => now,
    });

    const recordedEvents = (await listSessionStateEventsSince(watched, "main", 0, 20, database))
      .events;
    expect(recordedEvents).toHaveLength(1);
    // Event time is clamped into [now - 24h, now]; cursor rows keep the local clock
    // so a skewed upstream timestamp cannot age watch state into retention pruning.
    expect(recordedEvents[0]?.occurredAt).toBe(now - 24 * 60 * 60_000);
    const cursor = openOpenClawStateDatabase(database)
      .db.prepare("SELECT updated_at FROM session_watch_cursors WHERE target_session_key = ?")
      .get(watched) as { updated_at: number };
    expect(cursor.updated_at).toBe(now);
  });

  it("skips recording and marker writes when the link was refreshed mid-scan", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:refreshed";
    await createLink(watched, "claude", database);
    const claude = provider("claude", async (probes: SessionUpstreamProbe[]) => {
      // Simulate a Continue refreshing the link while the scan is in flight.
      upsertSessionUpstreamLink(
        {
          sessionKey: watched,
          agentId: "main",
          catalogId: "claude",
          hostId: "gateway:local",
          threadId: "thread-refreshed",
          upstreamKind: "claude-cli",
          upstreamRef: { source: "refreshed" },
          marker: { offset: 999 },
        },
        { ...database, now: 7_777 },
      );
      return probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_000,
        humanTurns: 1,
        nextMarker: { offset: 8 },
        dedupeId: "stale-8",
      }));
    });

    mockEntry(async () => ({ sessionId: "session-refreshed", updatedAt: 0 }));
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
    });

    expect(await events(database, watched)).toHaveLength(0);
    const row = openOpenClawStateDatabase(database)
      .db.prepare("SELECT last_marker_json FROM session_upstream_links WHERE session_key = ?")
      .get(watched) as { last_marker_json: string };
    expect(JSON.parse(row.last_marker_json)).toEqual({ offset: 999 });
  });

  it("isolates a session-entry load failure to that link", async () => {
    const database = createDatabaseOptions();
    const broken = "agent:main:adopted:broken";
    const healthy = "agent:main:adopted:healthy";
    await createLink(broken, "claude", database);
    await createLink(healthy, "claude", database);
    const claude = provider("claude", async (probes: SessionUpstreamProbe[]) =>
      probes.map((probe) => ({
        kind: "activity" as const,
        sessionKey: probe.sessionKey,
        occurredAt: 2_500,
        humanTurns: 1,
        nextMarker: { offset: 6 },
        dedupeId: "6",
      })),
    );

    mockEntry(async ({ sessionKey }) => {
      if (sessionKey === broken) {
        throw new Error("corrupt session store");
      }
      return { sessionId: "session-healthy", updatedAt: 0 };
    });
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
      now: () => 3_000,
    });

    expect(await events(database, broken)).toHaveLength(0);
    expect(await events(database, healthy)).toHaveLength(1);
  });

  it("preserves a coalesced upstream burst count in the event payload", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:burst";
    await createLink(sessionKey, "codex", database);

    mockEntry(async () => ({ sessionId: "session-burst", updatedAt: 0 }));
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("codex", async () => [
          {
            kind: "activity" as const,
            sessionKey,
            occurredAt: 2_000,
            humanTurns: 3,
            nextMarker: { turnId: "turn-3", userMessageCount: 1 },
            dedupeId: "turn-3:1",
          },
        ]),
      ],
    });

    expect(await events(database, sessionKey)).toEqual([
      expect.objectContaining({
        kind: "human_direct_message",
        payload: { turns: 3 },
      }),
    ]);
  });

  it("isolates provider failures", async () => {
    const database = createDatabaseOptions();
    const codexSession = "agent:main:adopted:codex";
    await createLink("agent:main:adopted:claude", "claude", database);
    await createLink(codexSession, "codex", database);
    const codexCheck = vi.fn(async () => [
      {
        kind: "activity" as const,
        sessionKey: codexSession,
        occurredAt: 5_000,
        humanTurns: 1,
        nextMarker: { turnId: "turn-2" },
        dedupeId: "turn-2",
      },
    ]);

    mockEntry(async () => ({ sessionId: "session", updatedAt: 0 }));
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => {
          throw new Error("broken");
        }),
        provider("codex", codexCheck),
      ],
    });

    expect(codexCheck).toHaveBeenCalledOnce();
    expect(await events(database, codexSession)).toHaveLength(1);
  });

  it("defers active runs without advancing their marker", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:active";
    await createLink(sessionKey, "claude", database);
    const check = vi.fn(async (_probes: SessionUpstreamProbe[]) => []);
    const claude = provider("claude", check);

    mockEntry(async () => ({ sessionId: "session-active", updatedAt: 0 }));
    mockRunActive(() => true);
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
    });
    expect(check).not.toHaveBeenCalled();

    mockEntry(async () => ({ sessionId: "session-active", updatedAt: 0 }));
    mockRunActive(() => false);
    mockOwnTexts();
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [claude],
    });

    expect(check).toHaveBeenCalledWith([expect.objectContaining({ marker: { offset: 0 } })], {
      allowProcessHomeFallback: false,
    });
  });

  it("defers activity when a run starts during the provider scan", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:active-race";
    await createLink(sessionKey, "claude", database);
    let active = false;
    const check = vi.fn(async (_probes: SessionUpstreamProbe[]) => {
      active = true;
      return [
        {
          kind: "activity" as const,
          sessionKey,
          occurredAt: 2_000,
          humanTurns: 1,
          nextMarker: { offset: 12 },
          dedupeId: "12",
        },
      ];
    });

    mockEntry(async () => ({ sessionId: "session-active-race", updatedAt: 0 }));
    mockRunActive(() => active);
    const options = monitorOptions(database, check);
    await runSessionUpstreamMonitorTick(options);
    active = false;
    check.mockResolvedValueOnce([]);
    await runSessionUpstreamMonitorTick(options);

    expect(check.mock.calls[1]?.[0]).toEqual([expect.objectContaining({ marker: { offset: 0 } })]);
    expect(await events(database, sessionKey)).toEqual([]);
  });

  it("supplies provenance text so a matching upstream prompt advances without an event", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:provenance";
    const sessionId = "session-provenance";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, env: database.env },
      { sessionId, updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { agentId: "main", sessionId, sessionKey, env: database.env },
      {
        cwd: process.cwd(),
        eventId: "user-message",
        message: {
          role: "user",
          content: "visible prompt",
          __openclaw: {
            mirrorOrigin: "codex-app-server",
            upstreamUserText: " exact   decorated prompt ",
          },
        },
      },
    );
    await createLink(sessionKey, "claude", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) => [
      {
        kind: "activity" as const,
        sessionKey,
        humanTurns: probes[0]?.ownRecentUserTexts.includes("exact decorated prompt") ? 0 : 1,
        nextMarker: { offset: 20 },
      },
    ]);

    mockRunActive(() => false);
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("claude", check)],
    });

    expect(check).toHaveBeenCalledWith(
      [expect.objectContaining({ ownRecentUserTexts: ["exact decorated prompt"] })],
      { allowProcessHomeFallback: false },
    );
    expect(await events(database, sessionKey)).toEqual([]);
    expect(readLink(database, sessionKey)?.marker).toEqual({ offset: 20 });
  });

  it("reports a matching external prompt after catalog history import", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:catalog-import";
    const sessionId = "session-catalog-import";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, env: database.env },
      { sessionId, updatedAt: 1 },
    );
    await importSessionCatalogHistory({
      catalogId: "pi",
      threadId: "thread-pi",
      read: async () => ({
        hostId: "gateway",
        threadId: "thread-pi",
        items: [{ id: "native-user-1", type: "userMessage", text: "repeat me" }],
      }),
      sessionId,
      sessionKey,
      agentId: "main",
      config: {},
    });
    await createLink(sessionKey, "pi", database);
    const check = vi.fn(async (probes: SessionUpstreamProbe[]) => [
      {
        kind: "activity" as const,
        sessionKey,
        occurredAt: 20_000,
        humanTurns: probes[0]?.ownRecentUserTexts.includes("repeat me") ? 0 : 1,
        nextMarker: { offset: 20 },
        dedupeId: "20",
      },
    ]);

    mockRunActive(() => false);
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [provider("pi", check)],
    });

    expect(check).toHaveBeenCalledWith([expect.objectContaining({ ownRecentUserTexts: [] })], {
      allowProcessHomeFallback: false,
    });
    expect(await events(database, sessionKey)).toEqual([
      expect.objectContaining({ kind: "human_direct_message", summary: "human message via pi" }),
    ]);
  });

  it("records an external prompt five seconds after OpenClaw activity", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:recent-external";
    await createLink(sessionKey, "claude", database);

    mockEntry(async () => ({ sessionId: "session-external", lastActivityAt: 5_000, updatedAt: 0 }));
    mockRunActive(() => false);
    mockOwnTexts(["OpenClaw prompt"]);
    await runSessionUpstreamMonitorTick({
      ...database,
      providers: [
        provider("claude", async () => [
          {
            kind: "activity" as const,
            sessionKey,
            occurredAt: 10_000,
            humanTurns: 1,
            nextMarker: { offset: 24 },
            dedupeId: "24",
          },
        ]),
      ],
    });

    expect(
      (await listSessionStateEventsSince(sessionKey, "main", 0, 20, database)).events,
    ).toHaveLength(1);
  });
});
