import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { registerSessionStateWatch } from "./session-state-events.js";
import { settleSessionUpstreamLink } from "./session-upstream-links-runtime.js";
import {
  deleteSessionUpstreamLink,
  deleteSessionUpstreamLinkAsync,
  listWatchedSessionUpstreamLinks,
  readSessionUpstreamLink,
  upsertSessionUpstreamLink,
  upsertSessionUpstreamLinkAsync,
  upsertSessionUpstreamLinkWithCurrentSource,
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
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session upstream links", () => {
  it("orders asynchronous writes and exact deletion without caller-thread SQL", async () => {
    const database = createDatabaseOptions();
    const input = {
      sessionKey: "agent:main:adopted:async",
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "async",
      upstreamKind: "codex-app-server" as const,
      upstreamRef: { threadId: "async" },
      marker: null,
    };
    const expected = { ...input, createdAt: 100, updatedAt: 100 };
    const sql = observeMainThreadSql();
    try {
      const first = upsertSessionUpstreamLinkAsync(input, {
        ...database,
        now: 100,
        ifAbsent: true,
      });
      const second = upsertSessionUpstreamLinkAsync(
        { ...input, threadId: "loser" },
        { ...database, ifAbsent: true },
      );
      expect(await Promise.all([first, second])).toEqual([true, false]);
      expect(
        await deleteSessionUpstreamLinkAsync(input.sessionKey, input.agentId, {
          ...database,
          expected: { ...expected, threadId: "other" },
        }),
      ).toBe("changed");
      expect(
        await deleteSessionUpstreamLinkAsync(input.sessionKey, input.agentId, {
          ...database,
          expected,
        }),
      ).toBe("deleted");
      expect(
        await deleteSessionUpstreamLinkAsync(input.sessionKey, input.agentId, {
          ...database,
          expected,
        }),
      ).toBe("absent");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(readSessionUpstreamLink(input.sessionKey, input.agentId, database)).toBeUndefined();
  });

  it("observes foreign source changes and rolls back a revoked commit grant", async () => {
    const database = createDatabaseOptions();
    const sourceKey = "agent:main:adopted:source";
    upsertLink(sourceKey, "claude", database);
    const source = readSessionUpstreamLink(sourceKey, "main", database)!;
    const child = { ...source, sessionKey: "agent:main:adopted:child" };
    const sourceCurrent = {
      context: captureOpenClawStateWorkerContext(database),
      expected: source,
      withCurrent: <T>(run: () => T) => run(),
    };
    expect(
      await upsertSessionUpstreamLinkWithCurrentSource(
        child,
        { ...database, ifAbsent: true },
        sourceCurrent,
      ),
    ).toBe(true);
    // The retained worker must see a commit from the released synchronous owner.
    upsertSessionUpstreamLink({ ...source, threadId: "replacement" }, database);
    await expect(
      upsertSessionUpstreamLinkWithCurrentSource(
        { ...child, sessionKey: "agent:main:adopted:stale" },
        { ...database, ifAbsent: true },
        sourceCurrent,
      ),
    ).rejects.toThrow("source changed");
    let revoked = false;
    const admission = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, ...args) =>
        admission(
          (request, grant) => {
            if (request.stage === "commit") {
              revoked = true;
            }
            admit(request, grant);
          },
          ...args,
        ),
    );
    await expect(
      deleteSessionUpstreamLinkAsync(child.sessionKey, child.agentId, {
        ...database,
        expected: readSessionUpstreamLink(child.sessionKey, child.agentId, database),
        assertCommitAllowed: () => {
          if (revoked) {
            throw new Error("initializer revoked");
          }
        },
      }),
    ).rejects.toThrow("initializer revoked");
    expect(readSessionUpstreamLink(child.sessionKey, child.agentId, database)).toBeDefined();
    expect(readSessionUpstreamLink("agent:main:adopted:stale", "main", database)).toBeUndefined();
  });
  it("returns each watched link once and skips ambiguous agent ownership without host SQL", async () => {
    const database = createDatabaseOptions();
    const watched = "agent:main:adopted:watched";
    const unwatched = "agent:main:adopted:unwatched";
    upsertLink(watched, "claude", database);
    upsertLink(unwatched, "codex", database);
    expect(
      await registerSessionStateWatch(
        { watcherSessionKey: "agent:main:main", targetSessionKey: watched },
        database,
      ),
    ).toBe(true);
    expect(
      await registerSessionStateWatch(
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
      await registerSessionStateWatch(
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

    const expected = readSessionUpstreamLink(watched, "main", database);
    if (!expected) {
      throw new Error("Expected watched link");
    }
    const markerSql = observeMainThreadSql();
    try {
      const results = await Promise.all([
        settleSessionUpstreamLink(
          expected,
          { kind: "activity", marker: { offset: 9 }, now: 200 },
          { ...database, assertCurrent: () => {} },
        ),
        settleSessionUpstreamLink(
          expected,
          { kind: "activity", marker: { offset: 10 }, now: 200 },
          { ...database, assertCurrent: () => {} },
        ),
      ]);
      expect(results).toEqual([true, false]);
      markerSql.expectIdle();
    } finally {
      markerSql.restore();
    }
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
    await registerSessionStateWatch(
      { watcherSessionKey: "agent:main:main", targetSessionKey: sessionKey },
      database,
    );
    const expected = readSessionUpstreamLink(sessionKey, "main", database);
    if (!expected) {
      throw new Error("Expected watched link");
    }
    await settleSessionUpstreamLink(
      expected,
      { kind: "activity", marker: { offset: 4 }, now: 200 },
      { ...database, assertCurrent: () => {} },
    );

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
