import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseByPathAsync as closeDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { noteCronJobsStoreCommit, saveCronJobsStore, saveCronJobsStoreChanges } from "../store.js";
import type { CronStoreFile } from "../types.js";
import { prepareCronJobNameResolver as prepareNames } from "./job-name.js";

const namedStore = (name: string): CronStoreFile => ({
  version: 1,
  jobs: [makeCronJob({ id: "report", name })],
});

afterEach(() => vi.restoreAllMocks());

it("reads absent cron metadata in legacy shared state without repairing it", async () => {
  await withOpenClawTestState({ label: "cron-name-legacy" }, async (fixture) => {
    const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1;");
    } finally {
      database.close();
    }
    const before = await fs.readFile(databasePath);
    const sql = observeMainThreadSql();
    const resolveName = await prepareNames(["legacy"], fixture.statePath("cron", "jobs.json"));
    expect(resolveName("legacy")).toBeUndefined();
    sql.expectIdle();
    expect(await fs.readFile(databasePath)).toEqual(before);
    sql.restore();
  });
});

it("retains committed names across saves without caller SQL and refuses invalidated generations", async () => {
  await withOpenClawTestState({ label: "cron-name-publication" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const store = namedStore("Original");
    await saveCronJobsStore(storePath, store);
    const sql = observeMainThreadSql();
    let resolveName = await prepareNames(["report", "missing"], storePath);
    expect(resolveName("report")).toBe("Original");
    expect(resolveName("missing")).toBeUndefined();
    expect((await prepareNames(["report"]))("report")).toBe("Original");
    expect(() => resolveName("unprepared")).toThrow(/refresh/);
    sql.expectIdle();
    const renamed = structuredClone(store);
    renamed.jobs[0]!.name = "Renamed";
    await saveCronJobsStoreChanges(storePath, store, renamed);
    expect(resolveName("report")).toBe("Renamed");
    await saveCronJobsStore(storePath, { version: 1, jobs: [] });
    expect(resolveName("report")).toBeUndefined();
    sql.expectIdle();
    // Unknown/repair outcomes must discard the old name until an explicit read succeeds.
    noteCronJobsStoreCommit(storePath);
    expect(() => resolveName("report")).toThrow(/refresh/);
    resolveName = await prepareNames(["report"], storePath);
    expect(resolveName("report")).toBeUndefined();
    sql.expectIdle();
    sql.restore();
    await closeDatabase(resolveOpenClawStateSqlitePath(fixture.env));
    await saveCronJobsStore(storePath, store);
    expect(() => resolveName("report")).toThrow(/admission|closing|changed/);
    expect((await prepareNames(["report"], storePath))("report")).toBe("Original");
  });
});

it("does not overwrite committed names with a delayed worker read", async () => {
  await withOpenClawTestState({ label: "cron-name-read-race" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    await saveCronJobsStore(storePath, { version: 1, jobs: [] });
    const read = stateReads.executeExistingOpenClawStateRead;
    const observed = createDeferred();
    const release = createDeferred();
    vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementationOnce(
      async (...args) => {
        const reply = await read(...args);
        observed.resolve();
        await release.promise;
        return reply;
      },
    );
    const pending = prepareNames(["report"], storePath);
    try {
      await awaitGateBeforeSettlement(
        observed.promise,
        pending,
        "Name read did not reach publication",
      );
      await saveCronJobsStore(storePath, namedStore("Committed"));
      release.resolve();
      expect((await pending)("report")).toBe("Committed");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });
});
