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
import { noteCronJobsStoreCommit, saveCronJobsStore } from "../store.js";
import { prepareCronJobNameResolver as prepareNames } from "./job-name.js";

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

it("keeps committed names through a delayed read and refuses invalidated generations", async () => {
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
    const pending = prepareNames(["report", "missing"], storePath);
    const store = { version: 1 as const, jobs: [makeCronJob({ id: "report", name: "Committed" })] };
    try {
      await awaitGateBeforeSettlement(
        observed.promise,
        pending,
        "Name read did not reach publication",
      );
      await saveCronJobsStore(storePath, store);
      release.resolve();
      const resolveName = await pending;
      expect(resolveName("report")).toBe("Committed");
      expect(resolveName("missing")).toBeUndefined();
      expect(() => resolveName("unprepared")).toThrow(/refresh/);
      noteCronJobsStoreCommit(storePath);
      expect(() => resolveName("report")).toThrow(/refresh/);
      const refreshed = await prepareNames(["report"]);
      expect(refreshed("report")).toBe("Committed");
      await closeDatabase(resolveOpenClawStateSqlitePath(fixture.env));
      await saveCronJobsStore(storePath, store);
      expect(() => refreshed("report")).toThrow(/admission|closing|changed/);
      expect((await prepareNames(["report"], storePath))("report")).toBe("Committed");
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
    }
  });
});
