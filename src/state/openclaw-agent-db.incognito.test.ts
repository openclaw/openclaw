import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareAgentDeleteDatabases } from "../agents/agent-delete-databases.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { beginAgentDeletionJournal } from "./agent-deletion-journal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabases,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  listOpenClawRegisteredAgentDatabases,
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  readOpenIncognitoAgentDatabaseGeneration,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });
});

describe("incognito agent database", () => {
  it.runIf(process.platform === "win32")(
    "matches mixed separators on drive and UNC roots without folding filename case",
    () => {
      for (const stateDir of ["C:\\incognito-state", "\\\\server\\share\\incognito-state"]) {
        const options = { agentId: "worker", env: { OPENCLAW_STATE_DIR: stateDir } };
        const sentinel = resolveIncognitoOpenClawAgentSqlitePath(options);
        expect(isIncognitoOpenClawAgentSqlitePath(sentinel.replaceAll("\\", "/"), options)).toBe(
          true,
        );
        expect(
          isIncognitoOpenClawAgentSqlitePath(
            path.join(path.dirname(sentinel), path.basename(sentinel).toUpperCase()),
            options,
          ),
        ).toBe(false);
      }
    },
  );

  it("matches only the normalized sentinel for the current owner and state root", () => {
    const env = { OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "incognito-path-root") };
    const options = { agentId: "worker", env };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath(options);
    const basename = path.basename(sentinel);
    for (const pathname of [
      sentinel,
      path.relative(process.cwd(), sentinel),
      `${sentinel}${path.sep}`,
      `${sentinel}${path.sep}.`,
      `${sentinel}${path.sep}..${path.sep}${basename}`,
    ]) {
      expect(isIncognitoOpenClawAgentSqlitePath(pathname, options), pathname).toBe(true);
    }
    for (const pathname of [
      path.join(path.dirname(sentinel), "openclaw-agent.sqlite"),
      path.join(env.OPENCLAW_STATE_DIR, basename),
      `${sentinel}-wal`,
      `${sentinel} `,
      path.join(path.dirname(sentinel), basename.toUpperCase()),
    ]) {
      expect(isIncognitoOpenClawAgentSqlitePath(pathname, options), pathname).toBe(false);
    }
    expect(isIncognitoOpenClawAgentSqlitePath(sentinel, { ...options, agentId: "other" })).toBe(
      false,
    );
    env.OPENCLAW_STATE_DIR = path.join(env.OPENCLAW_STATE_DIR, "changed");
    expect(isIncognitoOpenClawAgentSqlitePath(sentinel, options)).toBe(false);
    expect(
      isIncognitoOpenClawAgentSqlitePath(resolveIncognitoOpenClawAgentSqlitePath(options), options),
    ).toBe(true);
  });

  it.each([false, true])(
    "rejects deletion-fenced opens and writes and retires prepared statements (held: %s)",
    async (held) => {
      const stateDir = fs.realpathSync(tempDirs.make("incognito-delete-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "worker", env });
      const options = { agentId: "worker", env, path: sentinel };
      const database = held ? openOpenClawAgentDatabase(options) : undefined;
      const writeSql =
        "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'";
      const retained = database?.db.prepare(writeSql);
      beginAgentDeletionJournal(
        {
          agentId: "worker",
          operationId: "delete-worker",
          agentDir: path.dirname(sentinel),
          workspaceDir: path.join(stateDir, "workspace-worker"),
          sessionsDir: path.join(stateDir, "agents", "worker", "sessions"),
          deleteFiles: true,
        },
        { env },
      );

      expect.soft(() => openOpenClawAgentDatabase(options)).toThrow("is deleted");
      expect
        .soft(() =>
          runOpenClawAgentWriteTransaction(({ db }) => db.prepare(writeSql).run(), options),
        )
        .toThrow("is deleted");
      const plan = await prepareAgentDeleteDatabases(
        { agents: { entries: { worker: {}, kept: {} } } },
        "worker",
        path.dirname(sentinel),
        { env },
      );
      if (database && retained) {
        expect.soft(database.db.isOpen).toBe(false);
        expect.soft(() => retained.run()).toThrow();
      }
      expect(plan.registrationPaths).not.toContain(sentinel);
      expect(plan.fileGroups.flat()).not.toContain(sentinel);
      expect(fs.existsSync(sentinel)).toBe(false);
    },
  );

  it("does not allocate an in-memory database for a read-only miss", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-incognito-read-miss-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const before = listOpenIncognitoAgentDatabases();

    expect(
      withOpenClawAgentDatabaseReadOnly(() => "unreachable", {
        agentId: "main",
        env,
        path: sentinel,
      }),
    ).toEqual({ found: false, reason: "database-missing" });
    expect(listOpenIncognitoAgentDatabases()).toEqual(before);
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("refuses a file at the reserved sentinel path before opening in memory", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-incognito-collision-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "operator data", "utf8");

    let collision: unknown;
    try {
      openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    } catch (error) {
      collision = error;
    }
    expect(collision).toBeInstanceOf(Error);
    expect(collision).toMatchObject({
      name: "IncognitoAgentDatabasePathCollisionError",
      path: sentinel,
      message: expect.stringContaining("move or rename the file"),
    });

    fs.rmSync(sentinel);
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    expect(database.db.prepare("SELECT count(*) AS count FROM session_nodes").get()).toEqual({
      count: 0,
    });
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("boots the canonical schema in one cached memory handle without touching its sentinel path", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-incognito-db-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    const beforeGeneration = readOpenIncognitoAgentDatabaseGeneration();

    const first = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    const openedGeneration = readOpenIncognitoAgentDatabaseGeneration();
    const reopened = openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });

    expect(openedGeneration).toBeGreaterThan(beforeGeneration);
    expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(openedGeneration);
    expect(reopened).toBe(first);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    expect(listOpenIncognitoAgentDatabases()).toEqual([{ agentId: "main", storePath: sentinel }]);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
    expect(
      withOpenClawAgentDatabaseReadOnly((database) => database.db === first.db, {
        agentId: "main",
        env,
        path: sentinel,
      }),
    ).toEqual({ found: true, value: true });
    expect(
      first.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_nodes'")
        .get(),
    ).toEqual({ name: "session_nodes" });
    expect(first.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(() =>
      withOpenClawAgentDatabaseReadOnly(
        ({ db }) => db.prepare("SELECT * FROM missing_readonly_table").all(),
        { agentId: "main", env, path: sentinel },
      ),
    ).toThrow(/no such table: missing_readonly_table/);
    expect(first.db.isOpen).toBe(true);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.dirname(sentinel))).toBe(false);

    expect(closeOpenClawAgentDatabaseByPath(sentinel)).toBe(true);
    const closedGeneration = readOpenIncognitoAgentDatabaseGeneration();
    expect(closedGeneration).toBeGreaterThan(openedGeneration);
    expect(closeOpenClawAgentDatabaseByPath(sentinel)).toBe(false);
    expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(closedGeneration);
  });

  it("advances once when close-all removes incognito membership", () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-incognito-close-all-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
    openOpenClawAgentDatabase({ agentId: "main", env, path: sentinel });
    const openedGeneration = readOpenIncognitoAgentDatabaseGeneration();

    closeOpenClawAgentDatabases();
    const closedGeneration = readOpenIncognitoAgentDatabaseGeneration();
    expect(closedGeneration).toBeGreaterThan(openedGeneration);

    closeOpenClawAgentDatabases();
    expect(readOpenIncognitoAgentDatabaseGeneration()).toBe(closedGeneration);
  });

  it.each(["before", "after"])(
    "keeps only its shared authority handle warm when shared state opens %s Incognito",
    (opened) => {
      const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("incognito-authority-")) };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const early = opened === "before" ? openOpenClawStateDatabase({ env }) : undefined;
      const options = {
        agentId: "worker",
        env,
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "worker", env }),
      };
      const incognito = openOpenClawAgentDatabase(options);
      if (!early) {
        expect(fs.readdirSync(env.OPENCLAW_STATE_DIR)).toEqual([]);
      }
      const shared = early ?? openOpenClawStateDatabase({ env });
      const unrelated = openOpenClawStateDatabase({
        path: path.join(tempDirs.make("unrelated-authority-"), "state.sqlite"),
      });
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS + 1);
      expect(shared.db.isOpen).toBe(true);
      expect(unrelated.db.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(incognito);

      closeOpenClawAgentDatabaseByPath(options.path);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(shared.db.isOpen).toBe(false);
      const later = openOpenClawStateDatabase({ env });
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
      expect(later.db.isOpen).toBe(false);
    },
  );

  it("allows explicit shared-state replacement and releases retention after the last Incognito closes", () => {
    const env = { OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("incognito-replacement-")) };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const shared = openOpenClawStateDatabase({ env });
    const openIncognito = (agentId: string) => {
      const options = {
        agentId,
        env,
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId, env }),
      };
      return { options, database: openOpenClawAgentDatabase(options) };
    };
    const first = openIncognito("first");
    const second = openIncognito("second");
    openClawStateDatabaseCache.closeOpenClawStateDatabaseByPath(shared.path);
    expect(shared.db.isOpen).toBe(false);
    const replacement = openOpenClawStateDatabase({ env });
    closeOpenClawAgentDatabaseByPath(first.options.path);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(replacement.db.isOpen).toBe(true);
    expect(getOpenClawAgentDatabaseIfOpen(second.options)).toBe(second.database);
    closeOpenClawAgentDatabaseByPath(second.options.path);
    vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(replacement.db.isOpen).toBe(false);
  });
});
