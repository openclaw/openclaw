import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { importSessionCatalogHistory } from "../plugins/session-catalog-history-import.js";
import type {
  SessionCatalogProvider,
  SessionUpstreamActivity,
} from "../plugins/session-catalog.js";
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

type Check = NonNullable<SessionCatalogProvider["checkUpstreamActivity"]>;
type TickOptions = NonNullable<Parameters<typeof runSessionUpstreamMonitorTick>[0]>;
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-upstream-monitor-");
const sessionKey = "agent:main:adopted:a-watched";
const otherKey = "agent:main:adopted:b-other";
let database: { env: NodeJS.ProcessEnv };
let missingCounts: Map<string, { count: number; linkUpdatedAt: number }>;
let check = vi.fn<Check>();

beforeEach(() => {
  const stateDir = sessionDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({});
  database = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  missingCounts = new Map();
  check = vi.fn<Check>(async () => []);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

function provider(id = "claude", probe: Check = check): SessionCatalogProvider {
  return {
    id,
    label: id,
    list: async () => [],
    read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
    checkUpstreamActivity: probe,
  };
}
function linkInput(key = sessionKey, catalogId = "claude") {
  return {
    sessionKey: key,
    agentId: "main",
    catalogId,
    hostId: "gateway:local",
    threadId: `thread-${catalogId}`,
    upstreamKind: catalogId === "claude" ? ("claude-cli" as const) : ("codex-app-server" as const),
    upstreamRef: { source: catalogId },
    marker: { offset: 0 },
  };
}
async function createLink(key = sessionKey, catalogId = "claude", watched = true) {
  upsertSessionUpstreamLink(linkInput(key, catalogId), database);
  if (watched) {
    await registerSessionStateWatch(
      { watcherSessionKey: "agent:main:main", targetSessionKey: key },
      database,
    );
  }
}
async function watch(catalogId = "claude") {
  await createLink(sessionKey, catalogId);
  mockEntry(async () => ({ sessionId: "session", updatedAt: 0 }));
  mockOwnTexts();
}
function link(key = sessionKey) {
  return readSessionUpstreamLinkInDatabase(openOpenClawStateDatabase(database).db, key, "main");
}
async function events(key = sessionKey) {
  return (await listSessionStateEventsSince(key, "main", 0, 20, database)).events;
}
async function run(count = 1, options: TickOptions = {}) {
  for (let index = 0; index < count; index += 1) {
    await runSessionUpstreamMonitorTick(
      { ...database, providers: [provider()], ...options },
      missingCounts,
    );
  }
}
function activity(
  overrides: Partial<Extract<SessionUpstreamActivity, { kind: "activity" }>> = {},
): SessionUpstreamActivity {
  return {
    kind: "activity",
    sessionKey,
    occurredAt: 2_000,
    humanTurns: 1,
    nextMarker: { offset: 8 },
    dedupeId: "8",
    ...overrides,
  };
}
const missing = (): SessionUpstreamActivity[] => [{ kind: "missing", sessionKey }];
function refresh(changedSource = true) {
  const input = linkInput();
  if (changedSource) {
    input.threadId = "thread-refreshed";
    input.upstreamRef.source = "refreshed";
    input.marker.offset = 999;
  }
  upsertSessionUpstreamLink(input, { ...database, now: 7_777 });
}
const counts = () => [...missingCounts.values()].map((counter) => counter.count);

describe("session upstream monitor", () => {
  it("skips discovery without a capable provider and discovers new providers", async () => {
    const list = vi.spyOn(upstreamLinks, "listWatchedSessionUpstreamLinks");
    missingCounts.set("old-watch", { count: 2, linkUpdatedAt: 100 });
    await run(1, { providers: [] });
    expect(list).not.toHaveBeenCalled();
    expect(missingCounts.size).toBe(0);
    await watch();
    check.mockResolvedValue([activity()]);
    await run();
    expect(await events()).toHaveLength(1);
  });

  it("discards discovery after the monitor is aborted", async () => {
    await createLink();
    const lifecycle = new AbortController();
    const loadEntry = mockEntry(async () => ({ sessionId: "session", updatedAt: 100 }));
    missingCounts.set("previous-watch", { count: 2, linkUpdatedAt: 100 });
    const tick = run(1, { signal: lifecycle.signal });
    lifecycle.abort();
    await tick;
    expect(loadEntry).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect([...missingCounts]).toEqual([["previous-watch", { count: 2, linkUpdatedAt: 100 }]]);
  });

  it("continues the provider batch when one marker settlement loses its owner", async () => {
    await watch();
    await createLink(otherKey);
    vi.spyOn(upstreamRuntime, "settleSessionUpstreamLink").mockRejectedValueOnce(
      new Error("Upstream observation lost its idle session owner"),
    );
    check.mockImplementation(async (probes) =>
      probes.map((probe) =>
        activity({ sessionKey: probe.sessionKey, humanTurns: 0, nextMarker: { offset: 9 } }),
      ),
    );
    await run();
    const markers = [link()?.marker, link(otherKey)?.marker];
    expect(markers).toEqual([{ offset: 0 }, { offset: 9 }]);
  });

  it("keeps the marker available when its durable event insert fails", async () => {
    await watch();
    openOpenClawStateDatabase(database).db.exec(`
      CREATE TRIGGER reject_upstream_event BEFORE INSERT ON session_state_events
      BEGIN SELECT RAISE(FAIL, 'synthetic event write failure'); END;
    `);
    check.mockResolvedValue([activity()]);
    await run();
    expect(link()?.marker).toEqual({ offset: 0 });
    expect(await events()).toEqual([]);
  });

  it("records watched activity once and advances its marker without host SQL", async () => {
    await createLink();
    await createLink(otherKey, "claude", false);
    await upsertSessionEntryCore(
      { sessionKey, agentId: "main", env: database.env },
      { sessionId: "session", updatedAt: 100 },
    );
    mockOwnTexts();
    check.mockImplementation(async (probes) =>
      probes.map((probe) => activity({ sessionKey: probe.sessionKey })),
    );
    const hostSql = observeMainThreadSql();
    try {
      await run(2, { now: () => 3_000 });
      hostSql.expectIdle();
    } finally {
      hostSql.restore();
    }
    expect(await events()).toEqual([
      expect.objectContaining({ kind: "human_direct_message", occurredAt: 2_000 }),
    ]);
    expect(await events(otherKey)).toEqual([]);
    expect(link()?.marker).toEqual({ offset: 8 });
    expect(check.mock.calls.map(([probes]) => probes.map((probe) => probe.marker))).toEqual([
      [{ offset: 0 }],
      [{ offset: 8 }],
    ]);
    expect(check.mock.calls[0]?.[1]).toEqual({ allowProcessHomeFallback: false });
    const row = openOpenClawStateDatabase(database)
      .db.prepare("SELECT dedupe_key FROM session_state_events WHERE session_key = ?")
      .get(sessionKey) as { dedupe_key: string };
    expect(row.dedupe_key).toMatch(new RegExp(`^upstream:${sessionKey}:[0-9a-f]{16}:8$`));
    expect((await events())[0]?.payload).toBeUndefined();
  });

  it("records one missing event after three misses and removes the link", async () => {
    await watch();
    check.mockImplementation(async () => missing());
    await run(4);
    expect(link()).toBeUndefined();
    expect(missingCounts.size).toBe(0);
    expect(await events()).toEqual([
      expect.objectContaining({
        kind: "upstream_missing",
        actorType: "system",
        payload: { channel: "claude" },
      }),
    ]);
  });

  it("defers a third missing result when a run starts during the scan", async () => {
    await watch();
    let active = false;
    let scan = 0;
    check.mockImplementation(async () => {
      active = ++scan === 3;
      return missing();
    });
    mockRunActive(() => active);
    await run(3);
    expect(link()).toBeDefined();
    expect(await events()).toEqual([]);
    expect(counts()).toEqual([2]);
    active = false;
    await run();
    expect(link()).toBeUndefined();
    expect(await events()).toEqual([expect.objectContaining({ kind: "upstream_missing" })]);
  });

  it("resets a missing streak when the session is replaced during the scan", async () => {
    await watch();
    let sessionId = "before";
    let scan = 0;
    mockEntry(async () => ({ sessionId, updatedAt: 0 }));
    check.mockImplementation(async () => {
      if (++scan === 3) {
        sessionId = "after";
      }
      return missing();
    });
    await run(3);
    expect(missingCounts.size).toBe(0);
    expect(await events()).toEqual([]);
    await run(2);
    expect(counts()).toEqual([2]);
    expect(link()).toBeDefined();
  });

  it.each(["monitor", "scheduler"])(
    "joins a deferred probe without publication after %s stop",
    async (stopOwner) => {
      await watch();
      mockRunActive(() => false);
      const clock = createGatewaySchedulerClock(1_000);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const thirdResult = createDeferred<SessionUpstreamActivity[]>();
      const scanStarted = [createDeferred(), createDeferred(), createDeferred()] as const;
      let scan = 0;
      let probeSettled = false;
      check.mockImplementation(async () => {
        scanStarted[scan++]?.resolve();
        if (scan !== 3) {
          return missing();
        }
        const result = await thirdResult.promise;
        probeSettled = true;
        return result;
      });
      const monitor = startSessionUpstreamMonitor({
        scheduler,
        ...database,
        providers: [provider()],
      });
      try {
        await clock.advanceBy(15_000);
        await scanStarted[0].promise;
        await clock.advanceBy(45_000);
        await scanStarted[1].promise;
        const thirdWake = clock.advanceBy(60_000);
        await scanStarted[2].promise;
        let joined = false;
        const stopping = (stopOwner === "scheduler" ? scheduler.stop() : monitor.stop()).then(
          () => {
            expect(probeSettled).toBe(true);
            joined = true;
          },
        );
        expect(joined).toBe(false);
        thirdResult.resolve(missing());
        await stopping;
        await thirdWake;
        expect(link()?.marker).toEqual({ offset: 0 });
        expect(await events()).toEqual([]);
        if (stopOwner === "monitor") {
          const sibling = vi.fn();
          scheduler.schedule({ id: "sibling", delayMs: 1, run: sibling });
          await clock.advanceBy(60_000);
          expect(sibling).toHaveBeenCalledOnce();
          expect(scan).toBe(3);
        }
      } finally {
        thirdResult.resolve([]);
        await monitor.stop();
        await scheduler.stop();
      }
    },
  );

  it.each(["activity", "quiet"])("resets consecutive misses on %s", async (outcome) => {
    await watch();
    let scan = 0;
    check.mockImplementation(async () =>
      ++scan === 3 ? (outcome === "quiet" ? [] : [activity({ humanTurns: 0 })]) : missing(),
    );
    await run(5);
    expect(await events()).toEqual([]);
    expect(link()).toBeDefined();
    expect(counts()).toEqual([2]);
  });

  it("starts a fresh streak when Continue refreshes the same source", async () => {
    await watch();
    check.mockImplementation(async () => missing());
    await run(2);
    refresh(false);
    await run();
    expect(await events()).toEqual([]);
    expect(link()).toBeDefined();
    expect(counts()).toEqual([1]);
  });

  it.each(["missing", "activity"])(
    "discards %s when Continue changes the source mid-scan",
    async (kind) => {
      await watch();
      let scan = 0;
      check.mockImplementation(async () => {
        if (kind === "activity" || ++scan === 3) {
          refresh();
        }
        return kind === "missing" ? missing() : [activity()];
      });
      await run(kind === "missing" ? 3 : 1);
      expect(await events()).toEqual([]);
      expect(link()).toEqual(
        expect.objectContaining({ threadId: "thread-refreshed", marker: { offset: 999 } }),
      );
    },
  );

  it("prunes counters when a link leaves the watched set", async () => {
    await watch();
    check.mockImplementation(async () => missing());
    await run();
    expect(missingCounts.size).toBe(1);
    deleteSessionUpstreamLink(sessionKey, "main", database);
    await run();
    expect(missingCounts.size).toBe(0);
  });

  it("clamps skewed event times without touching bookkeeping clocks", async () => {
    await watch();
    const now = 100 * 24 * 60 * 60_000;
    check.mockResolvedValue([activity({ occurredAt: 1_000 })]);
    await run(1, { now: () => now });
    expect(await events()).toEqual([
      expect.objectContaining({ occurredAt: now - 24 * 60 * 60_000 }),
    ]);
    const cursor = openOpenClawStateDatabase(database)
      .db.prepare("SELECT updated_at FROM session_watch_cursors WHERE target_session_key = ?")
      .get(sessionKey) as { updated_at: number };
    expect(cursor.updated_at).toBe(now);
  });

  it.each(["entry", "provider"])("isolates %s failures", async (failure) => {
    await watch();
    await createLink(otherKey, failure === "provider" ? "codex" : "claude");
    if (failure === "entry") {
      mockEntry(async ({ sessionKey: key }) => {
        if (key === sessionKey) {
          throw new Error("corrupt session store");
        }
        return { sessionId: "healthy", updatedAt: 0 };
      });
    }
    check.mockImplementation(async (probes) => {
      if (failure === "provider") {
        throw new Error("broken");
      }
      return probes.map((probe) => activity({ sessionKey: probe.sessionKey }));
    });
    await run(1, {
      providers: [provider(), provider("codex", async () => [activity({ sessionKey: otherKey })])],
    });
    expect(await events()).toEqual([]);
    expect(await events(otherKey)).toHaveLength(1);
  });

  it("preserves the coalesced burst count", async () => {
    await watch("codex");
    check.mockResolvedValue([
      activity({
        humanTurns: 3,
        nextMarker: { turnId: "turn-3", userMessageCount: 1 },
        dedupeId: "turn-3:1",
      }),
    ]);
    await run(1, { providers: [provider("codex")] });
    expect(await events()).toEqual([
      expect.objectContaining({ kind: "human_direct_message", payload: { turns: 3 } }),
    ]);
  });

  it.each(["before", "during"])("defers activity when a run starts %s the scan", async (timing) => {
    await watch();
    let active = timing === "before";
    mockRunActive(() => active);
    check.mockImplementation(async () => {
      active = true;
      return [activity()];
    });
    await run();
    if (timing === "before") {
      expect(check).not.toHaveBeenCalled();
    }
    active = false;
    check.mockResolvedValue([]);
    await run();
    expect(check.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ marker: { offset: 0 } }),
    ]);
    expect(await events()).toEqual([]);
  });

  it.each([false, true])(
    "matches only OpenClaw provenance, not catalog-imported prompts (imported: %s)",
    async (imported) => {
      const sessionId = "session";
      const catalogId = imported ? "pi" : "claude";
      const text = "exact decorated prompt";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, env: database.env },
        { sessionId, updatedAt: 1 },
      );
      if (imported) {
        await importSessionCatalogHistory({
          catalogId,
          threadId: "thread-pi",
          read: async () => ({
            hostId: "gateway",
            threadId: "thread-pi",
            items: [{ id: "native-user", type: "userMessage", text }],
          }),
          sessionId,
          sessionKey,
          agentId: "main",
          config: {},
        });
      } else {
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
      }
      await createLink(sessionKey, catalogId);
      mockRunActive(() => false);
      check.mockImplementation(async (probes) => [
        activity({ humanTurns: probes[0]?.ownRecentUserTexts.includes(text) ? 0 : 1 }),
      ]);
      await run(1, { providers: [provider(catalogId)] });
      expect(check.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ ownRecentUserTexts: imported ? [] : [text] }),
      ]);
      expect(await events()).toEqual(
        imported
          ? [
              expect.objectContaining({
                kind: "human_direct_message",
                summary: "human message via pi",
              }),
            ]
          : [],
      );
      expect(link()?.marker).toEqual({ offset: 8 });
    },
  );

  it("records an external prompt five seconds after OpenClaw activity", async () => {
    await watch();
    mockEntry(async () => ({ sessionId: "session", lastActivityAt: 5_000, updatedAt: 0 }));
    mockRunActive(() => false);
    mockOwnTexts(["OpenClaw prompt"]);
    check.mockResolvedValue([activity({ occurredAt: 10_000 })]);
    await run();
    expect(await events()).toHaveLength(1);
  });
});
