// Tests session-state cleanup helpers used by integration fixtures.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite-read-pool.js";
import { readPersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "./session-state-cleanup.js";

describe("cleanupSessionStateForTest", () => {
  beforeEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSessionStoreCacheForTest();
    resetFileLockStateForTest();
  });

  it("waits for in-flight session store writer queues before clearing test state", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cleanup-"));
    const storePath = path.join(fixtureRoot, "openclaw-sessions.json");
    const started = createDeferred();
    const release = createDeferred();
    let cleanupPromise: Promise<void> | undefined;
    let running: Promise<void> | undefined;
    try {
      running = runExclusiveSessionStoreWrite(storePath, async () => {
        started.resolve();
        await release.promise;
      });

      await started.promise;

      let settled = false;
      cleanupPromise = cleanupSessionStateForTest().then(() => {
        settled = true;
      });

      // An empty drain settles before this event-loop checkpoint.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);

      release.resolve();
      await running;
      await cleanupPromise;
    } finally {
      release.resolve();
      await running?.catch(() => undefined);
      await cleanupPromise;
      await cleanupSessionStateForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("waits for SQLite session writers before closing their database handles", async () => {
    const fixtureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-session-cleanup-sqlite-"),
    );
    const databasePath = path.join(fixtureRoot, "openclaw-agent.sqlite");
    const env = { ...process.env, OPENCLAW_STATE_DIR: fixtureRoot };
    const started = createDeferred();
    const release = createDeferred();
    let database: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    let cleanupPromise: Promise<void> | undefined;

    const running = runExclusiveSqliteSessionWrite(
      { agentId: "main", env, path: databasePath },
      async () => {
        started.resolve();
        await release.promise;
        database = openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
      },
      "session.transcript.batch",
    );
    try {
      await started.promise;
      let cleanupSettled = false;
      cleanupPromise = cleanupSessionStateForTest({ stateDir: fixtureRoot }).then(() => {
        cleanupSettled = true;
      });

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(cleanupSettled).toBe(false);

      release.resolve();
      await running;
      await cleanupPromise;
      expect(database?.db.isOpen).toBe(false);
    } finally {
      release.resolve();
      await running;
      if (cleanupPromise) {
        await cleanupPromise;
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("closes pooled auth readers only within the requested state root", async () => {
    // openclaw-temp-dir: allow verifies state-root removal after scoped database cleanup
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-cleanup-auth-"));
    const targets = ["state", "state-sibling"].map((name) => {
      const stateDir = path.join(root, name);
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      return { stateDir, agentDir, databasePath: path.join(agentDir, "openclaw-agent.sqlite") };
    });
    const readers = new Map<string, ReturnType<typeof nodeSqlite.openNodeSqliteDatabase>>();
    const actualOpen = nodeSqlite.openNodeSqliteDatabase;
    const observer = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, options) => {
        const database = actualOpen(location, options);
        if (options?.readOnly) {
          readers.set(nodeSqlite.resolveSqliteFilesystemPath(location), database);
        }
        return database;
      });
    try {
      for (const target of targets) {
        openOpenClawAgentDatabase({
          agentId: "main",
          env: { ...process.env, OPENCLAW_STATE_DIR: target.stateDir },
          path: target.databasePath,
        });
        expect(readPersistedAuthProfileStoreRaw(target.agentDir)).toBeNull();
      }
      const selected = readers.get(
        nodeSqlite.resolveSqliteFilesystemPath(targets[0]!.databasePath),
      );
      const unrelated = readers.get(
        nodeSqlite.resolveSqliteFilesystemPath(targets[1]!.databasePath),
      );
      if (!selected || !unrelated) {
        throw new Error("expected both real pooled auth readers");
      }
      await cleanupSessionStateForTest();
      expect(selected.isOpen).toBe(true);
      expect(unrelated.isOpen).toBe(true);

      await cleanupSessionStateForTest({ stateDir: targets[0]!.stateDir });
      expect(selected.isOpen).toBe(false);
      expect(unrelated.isOpen).toBe(true);
      await fs.rm(targets[0]!.stateDir, { recursive: true, force: true });
      await expect(fs.stat(targets[0]!.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      observer.mockRestore();
      // Close retained readers on the original implementation before removing fixtures.
      for (const target of targets) {
        closeAuthProfileReadPool({ kind: "root", rootPath: target.stateDir });
        await cleanupSessionStateForTest({ stateDir: target.stateDir });
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
