import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, saveCronJobsStore } from "./store.js";
import type { CronStoreFile } from "./types.js";

it.each([false, true])(
  "loads cold readonly cron state off the host with artifact preservation=%s",
  async (preserveArtifacts) => {
    await withOpenClawTestState({ label: "cron-readonly-worker" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const store: CronStoreFile = {
        version: 1,
        jobs: [
          {
            id: "readonly-job",
            name: "scheduled café 🦞",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 2,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "main",
            wakeMode: "next-heartbeat",
            payload: { kind: "systemEvent", text: "persisted event" },
            state: { nextRunAtMs: 60_001 },
          },
        ],
      };
      await saveCronJobsStore(storePath, store);
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      const before = await fs.readFile(databasePath);
      const spies = {
        prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
        exec: vi.spyOn(DatabaseSync.prototype, "exec"),
        close: vi.spyOn(DatabaseSync.prototype, "close"),
        get: vi.spyOn(StatementSync.prototype, "get"),
        all: vi.spyOn(StatementSync.prototype, "all"),
        run: vi.spyOn(StatementSync.prototype, "run"),
        iterate: vi.spyOn(StatementSync.prototype, "iterate"),
      };
      try {
        const read = () => loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
        const loaded = await (preserveArtifacts ? withArtifactPreservingStateReads(read) : read());
        expect(loaded.store).toEqual(store);
        expect(loaded.configJobIndexes).toEqual([0]);
        expect(loaded.configJobRuntimeEntries[0]?.state).toEqual({ nextRunAtMs: 60_001 });
        expect(loaded.jobsFingerprint).toBeUndefined();
        expect(loaded.invalidConfigRows).toEqual([]);
        expect(
          Object.fromEntries(
            Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
          ),
        ).toEqual({ prepare: 0, exec: 0, close: 0, get: 0, all: 0, run: 0, iterate: 0 });
        expect(await fs.readFile(databasePath)).toEqual(before);
      } finally {
        for (const spy of Object.values(spies)) {
          spy.mockRestore();
        }
      }
    });
  },
);

it("leaves missing databases absent and legacy layouts unmigrated", async () => {
  await withOpenClawTestState({ label: "cron-readonly-legacy" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const empty = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env);
    expect(empty.store).toEqual({ version: 1, jobs: [] });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1;");
    db.close();
    const before = await fs.readFile(databasePath);
    expect(
      await withArtifactPreservingStateReads(() =>
        loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env),
      ),
    ).toEqual(empty);
    expect(await fs.readFile(databasePath)).toEqual(before);
    expect(await loadCronJobsStoreWithConfigJobsReadOnly(storePath, state.env)).toEqual(empty);
    expect(await fs.readFile(databasePath)).toEqual(before);
  });
});

it("preserves native diagnostic errors without repairing an incompatible cron table", async () => {
  await withOpenClawTestState({ label: "cron-readonly-diagnostic" }, async (state) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE cron_jobs(legacy_column TEXT)");
    db.close();
    const before = await fs.readFile(databasePath);
    await expect(
      loadCronJobsStoreWithConfigJobsReadOnly(state.statePath("cron", "jobs.json"), state.env),
    ).rejects.toMatchObject({
      code: "ERR_SQLITE_ERROR",
      message: expect.stringContaining("no such column"),
    });
    expect(await fs.readFile(databasePath)).toEqual(before);
  });
});
