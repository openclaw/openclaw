import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  acquireSessionCostUsageRefreshLock,
  isSessionCostUsageRefreshRunning,
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";
import * as integrityWorker from "./sqlite-integrity-worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { closing: false, retarget: false, refresh: false },
  { closing: true, retarget: false, refresh: false },
  { closing: false, retarget: true, refresh: false },
  { closing: false, retarget: true, refresh: true },
])(
  "joins pending native admission before a usage write (closing=$closing, retarget=$retarget, refresh=$refresh)",
  async ({ closing, retarget, refresh }) => {
    const root = tempDirs.make("openclaw-usage-admission-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const agentId = "usage-test";
      const databasePath = openOpenClawAgentDatabase({ agentId }).path;
      closeOpenClawAgentDatabasesForTest();
      const cwd = retarget
        ? vi.spyOn(process, "cwd").mockReturnValue(path.dirname(databasePath))
        : undefined;
      const retargeted = path.join(root, "other-cwd");
      if (retarget) {
        fs.mkdirSync(retargeted);
      }
      const sessionsDir = path.join(root, "sessions");
      const sessionFile = path.join(sessionsDir, "session.jsonl");
      if (refresh) {
        fs.mkdirSync(sessionsDir);
        fs.writeFileSync(
          sessionFile,
          JSON.stringify({ message: { role: "user", content: "hello" } }),
        );
      }
      const cachePath = retarget ? path.basename(databasePath) : databasePath;
      const nativeFinished = createDeferredCore();
      const release = createDeferredCore();
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker").mockImplementation(
        async (...args) => {
          try {
            await check(...args);
            nativeFinished.resolve();
            await release.promise;
          } catch (error) {
            nativeFinished.reject(error);
            throw error;
          }
        },
      );
      const opening = withOpenClawAgentDatabaseAsync(
        { agentId, path: databasePath },
        () => undefined,
      );
      const opened = Promise.allSettled([opening]);
      let writeSettled = false;
      const writing = Promise.resolve()
        .then(async () =>
          refresh
            ? await refreshCostUsageCacheForAgent({
                agentId,
                databasePath: cachePath,
                sessionsDir,
                agentDir: path.join(root, "agent-config"),
              })
            : await writeSessionCostUsageRollup({
                agentId,
                databasePath: cachePath,
                rollupId: "session.jsonl",
                previousValueJson: null,
                valueJson: '{"totalTokens":7}',
                updatedAt: 1,
              }),
        )
        .finally(() => {
          writeSettled = true;
        });
      const written = Promise.allSettled([writing]);
      let drain: Promise<void> | undefined;
      let drained = false;
      try {
        await nativeFinished.promise;
        await setImmediate();
        expect(writeSettled).toBe(false);
        expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
        cwd?.mockReturnValue(retargeted);
        if (closing) {
          drain = closeOpenClawAgentDatabasesAsync(root).then(() => {
            drained = true;
          });
          await setImmediate();
          expect(drained).toBe(false);
        }
        release.resolve();
        await opened;
        const [outcome] = await written;
        if (closing) {
          await drain;
          expect(outcome.status).toBe("rejected");
          expect(readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
        } else {
          expect(outcome).toEqual({ status: "fulfilled", value: refresh ? "refreshed" : true });
          expect(fs.existsSync(path.join(retargeted, path.basename(databasePath)))).toBe(false);
          const rows = readSessionCostUsageRollupRows(agentId, databasePath);
          if (refresh) {
            expect(rows.map((row) => row.key)).toEqual([sessionFile]);
          } else {
            expect(rows).toEqual([
              { key: "session.jsonl", valueJson: '{"totalTokens":7}', updatedAt: 1 },
            ]);
          }
        }
      } finally {
        release.resolve();
        await opened;
        await written;
        await drain;
      }
    });
  },
);

it("keeps refresh ownership after a rejected release until deletion commits", async () => {
  const root = tempDirs.make("openclaw-usage-lock-release-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const agentId = "usage-test";
    const owners = await Promise.all([
      acquireSessionCostUsageRefreshLock(agentId),
      acquireSessionCostUsageRefreshLock(agentId),
    ]);
    expect(owners.map((owner) => owner.acquired)).toEqual([true, false]);
    await owners[1].release();
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
    const database = openOpenClawAgentDatabase({ agentId });
    database.db.exec(`
      CREATE TEMP TRIGGER reject_refresh_release BEFORE DELETE ON cache_entries
      WHEN OLD.scope = 'session-cost-usage' AND OLD.key = 'refresh-lock'
      BEGIN SELECT RAISE(ABORT, 'release rejected'); END;
    `);
    await expect(owners[0].release()).rejects.toThrow("release rejected");
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
    database.db.exec("DROP TRIGGER reject_refresh_release");
    await owners[0].release();
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(false);
    const replacement = await acquireSessionCostUsageRefreshLock(agentId);
    expect(replacement.acquired).toBe(true);
    await owners[0].release();
    expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
    await replacement.release();
  });
});

it("reports a live refresh that replaces the stale lock before cleanup admission", async () => {
  const root = tempDirs.make("openclaw-usage-status-race-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const agentId = "usage-test";
    const database = openOpenClawAgentDatabase({ agentId });
    database.db
      .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("session-cost-usage", "refresh-lock", "{}", 1);
    const acquiring = acquireSessionCostUsageRefreshLock(agentId);
    const running = isSessionCostUsageRefreshRunning(agentId);
    const [owner, observedRunning] = await withEnvAsync(
      { OPENCLAW_STATE_DIR: path.join(root, "other-env") },
      () => Promise.all([acquiring, running]),
    );
    try {
      expect(owner.acquired).toBe(true);
      expect(observedRunning).toBe(true);
    } finally {
      await owner.release();
    }
  });
});

it("releases the acquired refresh lock after the caller changes its state directory", async () => {
  const originalRoot = tempDirs.make("openclaw-usage-lock-origin-");
  const otherRoot = tempDirs.make("openclaw-usage-lock-other-");
  const agentId = "usage-test";
  await withEnvAsync({ OPENCLAW_STATE_DIR: originalRoot }, async () => {
    const databasePath = openOpenClawAgentDatabase({ agentId }).path;
    const original = await acquireSessionCostUsageRefreshLock(agentId);
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: otherRoot }, async () => {
        const other = await acquireSessionCostUsageRefreshLock(agentId);
        try {
          await original.release();
          expect(await isSessionCostUsageRefreshRunning(agentId, databasePath)).toBe(false);
          expect(await isSessionCostUsageRefreshRunning(agentId)).toBe(true);
        } finally {
          await other.release();
        }
      });
    } finally {
      await original.release();
    }
  });
});
