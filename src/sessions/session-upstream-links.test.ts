import { existsSync } from "node:fs";
import path from "node:path";
import { constants, StatementSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { createNativeSessionInitializationOwner } from "../agents/harness/native-session/initialization.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createSessionInitialization } from "./session-initialization.js";
import { recordSessionStateEventAsync, registerSessionStateWatch } from "./session-state-events.js";
import {
  captureSessionUpstreamLinkReadSource,
  prepareSessionUpstreamLink as prepareLink,
  settleSessionUpstreamLink as settleLink,
} from "./session-upstream-links-runtime.js";
import {
  deleteSessionUpstreamLink as deleteLink,
  deleteSessionUpstreamLinkAsync as deleteAsync,
  listWatchedSessionUpstreamLinks as listWatched,
  upsertSessionUpstreamLink as upsert,
  upsertSessionUpstreamLinkAsync as upsertAsync,
  upsertSessionUpstreamLinkWithCurrentSource as upsertWithSource,
} from "./session-upstream-links.js";
import {
  readSessionUpstreamLinkInDatabase as readInDatabase,
  type SessionUpstreamLinkInput,
} from "./session-upstream-links.kernel.js";

const tempDirs: string[] = [];
const key = "agent:main:adopted:source";
let database: ReturnType<typeof createDatabaseOptions>;

function linkInput(
  sessionKey = key,
  overrides: Partial<SessionUpstreamLinkInput> = {},
): SessionUpstreamLinkInput {
  return {
    sessionKey,
    agentId: "main",
    catalogId: "codex",
    hostId: "gateway:local",
    threadId: "created",
    upstreamKind: "codex-app-server",
    upstreamRef: { threadId: "created" },
    marker: null,
    ...overrides,
  };
}

function createDatabaseOptions() {
  const stateDir = makeTempDir(tempDirs, "openclaw-session-upstream-links-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({}, {});
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function readLink(sessionKey = key) {
  return readInDatabase(openOpenClawStateDatabase(database).db, sessionKey, "main");
}
function watch(targetSessionKey = key, watcherSessionKey = "agent:main:main") {
  return registerSessionStateWatch({ watcherSessionKey, targetSessionKey }, database);
}
async function withoutHostSql(run: () => Promise<void>) {
  const sql = observeMainThreadSql();
  try {
    await run();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

function upsertLink(sessionKey = key, catalogId = "codex") {
  upsert(
    linkInput(sessionKey, {
      catalogId,
      threadId: `thread-${sessionKey}`,
      upstreamKind: catalogId === "claude" ? "claude-cli" : "codex-app-server",
      upstreamRef: { source: sessionKey },
      marker: { offset: 1 },
    }),
    { ...database, now: 100 },
  );
}
const settle = (expected: NonNullable<ReturnType<typeof readLink>>, offset: number) =>
  settleLink(
    expected,
    { kind: "activity", marker: { offset }, now: 200 },
    { ...database, assertCurrent: () => {} },
  );

beforeEach(() => {
  database = createDatabaseOptions();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTempDirs(tempDirs);
});

describe("session upstream links", () => {
  it("reuses only the admitted exact link and observes mutation and snapshot boundaries", () => {
    upsertLink();
    const { db: connection, path: databasePath } = openOpenClawStateDatabase(database);
    const db = requireNativeSqliteDatabase(connection);
    const read = (sessionKey = key, agentId = "main") =>
      runSqliteReadOperationSync(db, () => readInDatabase(db, sessionKey, agentId));
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const count = () =>
      reads.queries.filter((sql) => /^select .* from "session_upstream_links"/iu.test(sql)).length;
    try {
      const first = read();
      expect(first?.upstreamRef).toEqual({ source: key });
      const ref = first?.upstreamRef;
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
        throw new Error("Expected the fixture's upstream reference");
      }
      ref.source = "caller-owned";
      expect(read()?.upstreamRef).toEqual({ source: key });
      expect(count()).toBe(1);

      expect(read(key, "other")).toBeUndefined();
      expect(read(key, "other")).toBeUndefined();
      expect(count()).toBe(2);
      const absent = `${key}:absent`;
      expect(read(absent)).toBeUndefined();
      expect(read(absent)).toBeUndefined();
      expect(count()).toBe(3);
      upsertLink(absent);
      expect(read(absent)?.sessionKey).toBe(absent);

      const update = db.prepare(
        "UPDATE session_upstream_links SET thread_id = ? WHERE session_key = ?",
      );
      expect(read()?.threadId).toBe(`thread-${key}`);
      update.run("local-replacement", key);
      expect(read()?.threadId).toBe("local-replacement");
      const foreign = openNodeSqliteDatabase(databasePath);
      try {
        foreign
          .prepare("UPDATE session_upstream_links SET thread_id = ? WHERE session_key = ?")
          .run("foreign-replacement", key);
      } finally {
        foreign.close();
      }
      expect(read()?.threadId).toBe("foreign-replacement");
      const afterForeign = count();
      expect(read()?.threadId).toBe("foreign-replacement");
      expect(count()).toBe(afterForeign);

      db.exec("BEGIN IMMEDIATE");
      try {
        update.run("rolled-back", key);
        const before = count();
        expect(read()?.threadId).toBe("rolled-back");
        expect(read()?.threadId).toBe("rolled-back");
        expect(count() - before).toBe(2);
      } finally {
        db.exec("ROLLBACK");
      }
      expect(read()?.threadId).toBe("foreign-replacement");
      runSqliteReadSnapshotSync(db, () => {
        const before = count();
        expect(read()?.threadId).toBe("foreign-replacement");
        expect(read()?.threadId).toBe("foreign-replacement");
        expect(count() - before).toBe(2);
      });

      let allowed = true;
      db.setAuthorizer((action, table) =>
        !allowed && action === constants.SQLITE_READ && table === "session_upstream_links"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      expect(read()?.threadId).toBe("foreign-replacement");
      allowed = false;
      expect(read).toThrow(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 23 }));
    } finally {
      db.setAuthorizer(null);
      reads.restore();
    }
  });

  it("orders asynchronous writes and exact deletion without caller-thread SQL", async () => {
    const input = linkInput();
    const expected = { ...input, createdAt: 100, updatedAt: 100 };
    await withoutHostSql(async () => {
      const first = upsertAsync(input, {
        ...database,
        now: 100,
        ifAbsent: true,
      });
      const second = upsertAsync({ ...input, threadId: "loser" }, { ...database, ifAbsent: true });
      expect(await Promise.all([first, second])).toEqual([true, false]);
      const source = captureSessionUpstreamLinkReadSource();
      const remove = (expectedLink = expected) =>
        deleteAsync(input.sessionKey, input.agentId, {
          ...database,
          expected: expectedLink,
        });
      expect(await prepareLink(source, input.sessionKey, input.agentId)).toEqual(expected);
      expect(await remove({ ...expected, threadId: "other" })).toBe("changed");
      expect(await remove()).toBe("deleted");
      expect(await remove()).toBe("absent");
      expect(await prepareLink(source, input.sessionKey, input.agentId)).toBeUndefined();
    });
    expect(readLink()).toBeUndefined();
  });

  it.each([
    ["async", false],
    ["async", true],
    ["legacy", false],
  ] as const)(
    "%s initializer rolls back only its own link (replaced: %s)",
    async (mode, replaced) => {
      const input = linkInput();
      const identity = { sessionId: "created" };
      const bindingStore = {};
      const cleanup = vi.fn(async () => {});
      const owner = createNativeSessionInitializationOwner({
        validateBinding: (binding: string) => binding,
        writeBinding: async () => true,
        errors: {
          linkChanged: "link changed",
          bindingChanged: "binding changed",
          linkWriteFailed: "link write failed",
          ownerChanged: "owner changed",
        },
      });
      const host = createSessionInitialization(
        { storePath: "unused", sessionKey: input.sessionKey, sessionId: identity.sessionId },
        () => {},
        { config: {}, agentId: input.agentId, entry: { ...identity, updatedAt: 1 } },
      );
      const sql = observeMainThreadSql();
      try {
        const initialization = owner.prepare({
          initialization: host.handle,
          bindingStore,
          identity,
          prepareCleanup: () => cleanup,
        });
        using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
        await withPluginRuntimePluginScope(
          { pluginId: `native-initializer-${mode}-${replaced}` },
          async () => {
            if (mode === "legacy") {
              initialization.link(input);
            } else {
              await initialization.linkAsync(input);
            }
          },
        );
        const notices = warning.mock.calls.filter(([message]) =>
          String(message).includes("createNativeSessionInitializationOwner.prepare.link"),
        );
        expect(notices).toHaveLength(mode === "legacy" ? 1 : 0);
        if (mode === "legacy") {
          expect(notices[0]?.[0]).toContain(
            "createNativeSessionInitializationOwner.prepare.linkAsync",
          );
          expect(notices[0]?.[0]).toContain("Final compatibility day: 2026-12-31");
          expect(notices[0]?.[0]).toContain("first January 2027 stable release");
          sql.clear();
        }
        const source = captureSessionUpstreamLinkReadSource();
        const read = () => prepareLink(source, input.sessionKey, input.agentId);
        expect(await read()).toMatchObject(input);
        if (replaced) {
          await upsertAsync({ ...input, threadId: "replacement" }, database);
        }
        await host.rollback(async () => {
          const rollback = owner.getRollback(
            bindingStore,
            { initialization: host.handle },
            identity,
            undefined,
          );
          expect(rollback).toBeTypeOf("function");
          if (!rollback) {
            throw new Error("Missing initialization rollback");
          }
          if (replaced) {
            await expect(rollback()).rejects.toThrow("link changed");
          } else {
            await rollback();
          }
        });
        expect(await read()).toEqual(
          replaced ? expect.objectContaining({ threadId: "replacement" }) : undefined,
        );
        expect(cleanup).toHaveBeenCalledTimes(replaced ? 0 : 1);
        sql.expectIdle();
      } finally {
        sql.restore();
        host.close();
      }
    },
  );

  it("observes source changes and rejects stale initialization", async () => {
    upsertLink(key, "claude");
    const reader = captureSessionUpstreamLinkReadSource();
    const source = (await prepareLink(reader, key, "main"))!;
    const child = { ...source, sessionKey: "agent:main:adopted:child" };
    const sourceCurrent = {
      context: captureOpenClawStateWorkerContext(database),
      expected: source,
      withCurrent: <T>(run: () => T) => run(),
    };
    expect(await upsertWithSource(child, { ...database, ifAbsent: true }, sourceCurrent)).toBe(
      true,
    );
    // The retained worker must see a commit from the released synchronous owner.
    upsert({ ...source, threadId: "replacement" }, database);
    await withoutHostSql(async () => {
      expect(await prepareLink(reader, key, "main")).toMatchObject({
        threadId: "replacement",
      });
    });
    await expect(
      upsertWithSource(
        { ...child, sessionKey: "agent:main:adopted:stale" },
        { ...database, ifAbsent: true },
        sourceCurrent,
      ),
    ).rejects.toThrow("source changed");
    expect(readLink("agent:main:adopted:stale")).toBeUndefined();
  });
  it.each(["watch-then-link", "link-then-watch", "link-then-event"])(
    "skips empty upstream scans until %s creates a watched link",
    async (order) => {
      const watcherSessionKey = "agent:main:subagent:idle-watch";
      const addWatch = () => watch(key, watcherSessionKey);
      if (order === "watch-then-link") {
        expect(await addWatch()).toBe(true);
      } else {
        upsertLink();
      }
      const requests = vi.spyOn(stateWorker, "executeOpenClawStateWorker");
      const listRequests = () =>
        requests.mock.calls.filter(([, command]) => command.type === "sessionUpstream.listWatched");
      expect([...(await listWatched(database))]).toEqual([]);
      expect([...(await listWatched(database))]).toEqual([]);
      expect(listRequests()).toHaveLength(1);
      if (order === "watch-then-link") {
        expect(
          await upsertAsync(
            linkInput(key, {
              threadId: "idle-thread",
              upstreamRef: { source: key },
            }),
            database,
          ),
        ).toBe(true);
      } else if (order === "link-then-watch") {
        expect(await addWatch()).toBe(true);
      } else {
        expect(
          await recordSessionStateEventAsync(
            {
              sessionKey: key,
              agentId: "main",
              kind: "human_direct_message",
              actorType: "human",
              summary: "New upstream activity",
              watcherSessionKeys: [watcherSessionKey],
              watcherStorePaths: {},
            },
            database,
          ),
        ).toBeDefined();
      }
      expect((await listWatched(database)).get("codex")).toEqual([
        expect.objectContaining({ sessionKey: key, agentId: "main" }),
      ]);
      expect(listRequests()).toHaveLength(2);
    },
  );

  it("keeps watched links distinct and carries scan progress only across same-source refreshes", async () => {
    upsertLink(key, "claude");
    upsertLink("agent:main:adopted:unwatched");
    expect(await watch()).toBe(true);
    expect(await watch(key, "agent:other:main")).toBe(true);
    const ambiguous = "agent:main:adopted:ambiguous";
    upsertLink(ambiguous, "claude");
    expect(
      upsert(
        linkInput(ambiguous, {
          agentId: "other",
          threadId: "ambiguous-thread",
          upstreamRef: null,
        }),
        database,
      ),
    ).toBe(true);
    expect(await watch(ambiguous)).toBe(true);

    await closeOpenClawStateDatabaseAsync();
    await withoutHostSql(async () => {
      const watched = await listWatched(database);
      expect(watched.size).toBe(1);
      expect(watched.get("claude")).toMatchObject([
        { sessionKey: key, marker: { offset: 1 }, upstreamRef: { source: key } },
      ]);
    });

    const expected = readLink();
    if (!expected) {
      throw new Error("Expected watched link");
    }
    await withoutHostSql(async () => {
      expect(await Promise.all([settle(expected, 9), settle(expected, 10)])).toEqual([true, false]);
    });
    expect((await listWatched(database)).get("claude")?.[0]).toMatchObject({
      marker: { offset: 9 },
      lastScannedAt: 200,
      updatedAt: 200,
    });
    upsert({ ...expected, marker: { offset: 99 } }, database);
    expect((await listWatched(database)).get("claude")?.[0]).toMatchObject({
      upstreamRef: { source: key },
      marker: { offset: 9 },
    });
    upsert(
      {
        ...expected,
        threadId: "thread-refreshed",
        upstreamRef: { source: "rebased" },
        marker: { offset: 99 },
      },
      database,
    );
    expect((await listWatched(database)).get("claude")?.[0]).toMatchObject({
      threadId: "thread-refreshed",
      upstreamRef: { source: "rebased" },
      marker: { offset: 99 },
    });

    deleteLink(key, "main", database);
    expect([...(await listWatched(database))]).toEqual([]);
  });

  it("creates missing state through the worker and keeps discovery failure best-effort", async () => {
    const hostSql = observeMainThreadSql();
    try {
      expect([...(await listWatched(database))]).toEqual([]);
      hostSql.expectIdle();
      expect(
        existsSync(path.join(database.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite")),
      ).toBe(true);
      expect([
        ...(await listWatched({
          ...database,
          path: database.env.OPENCLAW_STATE_DIR,
        })),
      ]).toEqual([]);
      hostSql.expectIdle();
    } finally {
      hostSql.restore();
    }
  });
});
