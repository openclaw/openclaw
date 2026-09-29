import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { registerSessionStateWatch } from "./session-state-events.js";
import {
  deleteSessionUpstreamLink,
  listWatchedSessionUpstreamLinks,
  updateSessionUpstreamLinkMarker,
  upsertSessionUpstreamLink,
} from "./session-upstream-links.js";

const tempDirs: string[] = [];

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-upstream-links-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function upsertLink(
  sessionKey: string,
  catalogId: string,
  database: ReturnType<typeof createDatabaseOptions>,
) {
  upsertSessionUpstreamLink(
    {
      sessionKey,
      agentId: "main",
      catalogId,
      hostId: "gateway:local",
      threadId: `thread-${sessionKey}`,
      upstreamKind: catalogId === "claude" ? "claude-cli" : "codex-app-server",
      upstreamRef: { source: sessionKey },
      marker: { offset: 1 },
    },
    { ...database, now: 100 },
  );
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session upstream links", () => {
  it("returns each watched link once and skips ambiguous agent ownership without host SQL", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:watched";
    const unwatched = "agent:main:adopted:unwatched";
    upsertLink(watched, "claude", database);
    upsertLink(unwatched, "codex", database);
    expect(
      registerSessionStateWatch(
        { watcherSessionKey: "agent:main:main", targetSessionKey: watched },
        database,
      ),
    ).toBe(true);
    expect(
      registerSessionStateWatch(
        { watcherSessionKey: "agent:other:main", targetSessionKey: watched },
        database,
      ),
    ).toBe(true);
    const ambiguous = "agent:main:adopted:ambiguous";
    upsertLink(ambiguous, "claude", database);
    expect(
      upsertSessionUpstreamLink(
        {
          sessionKey: ambiguous,
          agentId: "other",
          catalogId: "codex",
          hostId: "gateway:local",
          threadId: "ambiguous-thread",
          upstreamKind: "codex-app-server",
          upstreamRef: null,
          marker: null,
        },
        database,
      ),
    ).toBe(true);
    expect(
      registerSessionStateWatch(
        { watcherSessionKey: "agent:main:main", targetSessionKey: ambiguous },
        database,
      ),
    ).toBe(true);

    await closeOpenClawStateDatabaseAsync();
    const hostSql = observeMainThreadSql();
    try {
      expect([...(await listWatchedSessionUpstreamLinks(database))]).toEqual([
        [
          "claude",
          [
            expect.objectContaining({
              sessionKey: watched,
              marker: { offset: 1 },
              upstreamRef: { source: watched },
            }),
          ],
        ],
      ]);

      hostSql.expectIdle();
    } finally {
      hostSql.restore();
    }

    updateSessionUpstreamLinkMarker(watched, "main", { offset: 9 }, { ...database, now: 200 });
    expect((await listWatchedSessionUpstreamLinks(database)).get("claude")?.[0]).toEqual(
      expect.objectContaining({ marker: { offset: 9 }, lastScannedAt: 200, updatedAt: 200 }),
    );

    deleteSessionUpstreamLink(watched, "main", database);
    expect([...(await listWatchedSessionUpstreamLinks(database))]).toEqual([]);
  });

  it("creates missing state through the worker and keeps discovery failure best-effort", async () => {
    const database = createDatabaseOptions();
    const hostSql = observeMainThreadSql();
    try {
      expect([...(await listWatchedSessionUpstreamLinks(database))]).toEqual([]);
      hostSql.expectIdle();
      expect(
        existsSync(path.join(database.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite")),
      ).toBe(true);
      expect([
        ...(await listWatchedSessionUpstreamLinks({
          ...database,
          path: database.env.OPENCLAW_STATE_DIR,
        })),
      ]).toEqual([]);
      hostSql.expectIdle();
    } finally {
      hostSql.restore();
    }
  });

  it("preserves the marker on same-source refresh and rebases it on source change", async () => {
    const database = createDatabaseOptions();
    const sessionKey = "agent:main:adopted:refresh";
    upsertLink(sessionKey, "claude", database);
    registerSessionStateWatch(
      { watcherSessionKey: "agent:main:main", targetSessionKey: sessionKey },
      database,
    );
    updateSessionUpstreamLinkMarker(sessionKey, "main", { offset: 4 }, database);

    // Same source (thread/host/kind unchanged): scan progress must survive.
    upsertSessionUpstreamLink(
      {
        sessionKey,
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: `thread-${sessionKey}`,
        upstreamKind: "claude-cli",
        upstreamRef: { source: sessionKey },
        marker: { offset: 99 },
      },
      database,
    );
    expect((await listWatchedSessionUpstreamLinks(database)).get("claude")?.[0]).toEqual(
      expect.objectContaining({
        upstreamRef: { source: sessionKey },
        marker: { offset: 4 },
      }),
    );

    // Source change: the old cursor is meaningless for the new thread; rebase.
    upsertSessionUpstreamLink(
      {
        sessionKey,
        agentId: "main",
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-refreshed",
        upstreamKind: "claude-cli",
        upstreamRef: { source: "rebased" },
        marker: { offset: 99 },
      },
      database,
    );
    expect((await listWatchedSessionUpstreamLinks(database)).get("claude")?.[0]).toEqual(
      expect.objectContaining({
        threadId: "thread-refreshed",
        upstreamRef: { source: "rebased" },
        marker: { offset: 99 },
      }),
    );
  });
});
