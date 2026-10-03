import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertCronJobsStoreUnchanged,
  CronJobsStoreChangedError,
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  loadCronStore,
  saveCronJobsStore,
  saveCronStore,
} from "./store.js";
import { createStorePathFixture, makeStore } from "./store.test-support.js";
import { cronStoreKey } from "./store/key.js";
import { loadCronStoreFromDatabase } from "./store/load.kernel.js";

const makeStorePath = createStorePathFixture();

function makeAuthorityStore(jobId: string) {
  const store = makeStore(jobId, true);
  const job = store.jobs[0];
  job.owner = {
    agentId: "main",
    sessionKey: "agent:main:discord:group:ops",
    accountId: "work",
  };
  job.sessionTarget = "isolated";
  job.payload = {
    kind: "agentTurn",
    message: "scheduled continuation",
    toolsAllow: ["read", "cron"],
    toolsAllowIsDefault: true,
  };
  job.scheduledToolPolicy = {
    version: 1,
    mode: "account",
    ownerSessionKey: "agent:main:discord:group:ops",
    ownerAccountId: "work",
  };
  job.toolsAllowProvenance = { version: 1, source: "final-executable-surface" };
  job.runtimeAuthority = {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: { apps: [{ id: "calendar" }] },
  };
  return store;
}

describe("cron store", () => {
  it("round-trips the toolsAllow default-cap flag through SQLite", async () => {
    // The flag must survive a gateway restart: without it, a CLI-resolved run
    // would re-hit the prepare.ts toolsAllow rejection after reload (#91499).
    const store = await makeStorePath();
    const payload = makeStore("tools-allow-default-job", true);
    payload.jobs[0].sessionTarget = "isolated";
    payload.jobs[0].payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    };

    await saveCronStore(store.storePath, payload);

    expect((await loadCronStore(store.storePath)).jobs[0]?.payload).toMatchObject({
      kind: "agentTurn",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
  });

  it("preserves runtime authority when an older writer rewrites job_json", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("downgrade-authority-job");
    const job = authorityStore.jobs[0];

    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const downgradedJob = JSON.parse(row.job_json) as Record<string, unknown>;
    delete downgradedJob.runtimeAuthority;
    delete downgradedJob.runtimeAuthorityRecoveryRequired;
    downgradedJob.description = "edited by an older build";
    database
      .prepare("UPDATE cron_jobs SET description = ?, job_json = ? WHERE job_id = ?")
      .run("edited by an older build", JSON.stringify(downgradedJob), job.id);

    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.description).toBe("edited by an older build");
    expect(reloaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
    expect(reloaded?.runtimeAuthorityRecoveryRequired).toBeUndefined();
  });

  it("stores authority outside job_json and restores it after reopen", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("authority-companion-row");
    const job = authorityStore.jobs[0];

    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    const parent = database
      .prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { job_json: string };
    const parentJson = JSON.parse(parent.job_json) as Record<string, unknown>;
    expect(parentJson).not.toHaveProperty("runtimeAuthority");
    expect(parentJson).not.toHaveProperty("runtimeAuthorityRecoveryRequired");
    const child = database
      .prepare(
        "SELECT authority_json, authority_input_fingerprint, recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?",
      )
      .get(job.id) as {
      authority_json: string;
      authority_input_fingerprint: string;
      recovery_required: number;
    };
    expect(JSON.parse(child.authority_json)).toEqual(job.runtimeAuthority);
    expect(child.authority_input_fingerprint).toMatch(/^v1:[a-f0-9]{64}$/u);
    expect(child.recovery_required).toBe(0);

    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
    expect(reloaded?.runtimeAuthorityRecoveryRequired).toBeUndefined();
    const readOnly = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs[0];
    expect(readOnly?.runtimeAuthority).toEqual(job.runtimeAuthority);
  });

  it("round-trips the restrict-only exec target and drops foreign shapes", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("exec-target-round-trip");
    const job = authorityStore.jobs[0];
    job.payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["exec", "read"],
    };
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    };

    await saveCronStore(storePath, authorityStore);
    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.payload.toolsAllow).toEqual(["exec", "read"]);
    expect(reloaded?.toolsAllowExecTarget).toEqual({
      version: 1,
      host: "gateway",
      ask: "always",
    });
    expect(reloaded?.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    });

    // A damaged target cannot rehydrate the private exec grant.
    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const edited = JSON.parse(row.job_json) as Record<string, unknown>;
    expect((edited.payload as { toolsAllow?: string[] }).toolsAllow).toEqual(["read"]);
    edited.toolsAllowExecTarget = { version: 1, host: "node" };
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const rejected = (await loadCronStore(storePath)).jobs[0];
    expect(rejected?.toolsAllowExecTarget).toBeUndefined();
    expect(rejected?.payload.toolsAllow).toEqual(["read"]);

    // Older writers may drop both private fields, but cannot restore broad exec.
    const requirement = edited.toolsAllowExecTargetRequirement;
    delete edited.toolsAllowExecTarget;
    delete edited.toolsAllowExecTargetRequirement;
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const downgraded = (await loadCronStore(storePath)).jobs[0];
    expect(downgraded?.payload.toolsAllow).toEqual(["read"]);

    // Extra keys from a newer writer are tolerated: known fields rebuild cleanly.
    edited.toolsAllowExecTargetRequirement = requirement;
    edited.toolsAllowExecTarget = {
      version: 1,
      host: "gateway",
      ask: "always",
      note: "future-field",
    };
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const tolerated = (await loadCronStore(storePath)).jobs[0];
    expect(tolerated?.toolsAllowExecTarget).toEqual({
      version: 1,
      host: "gateway",
      ask: "always",
    });
    expect(tolerated?.payload.toolsAllow).toEqual(["exec", "read"]);

    edited.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "off" };
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(edited), job.id);
    const nonRestrictiveAsk = (await loadCronStore(storePath)).jobs[0];
    expect(nonRestrictiveAsk?.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway" });
    expect(nonRestrictiveAsk?.payload.toolsAllow).toEqual(["read"]);
  });

  it("never stores broad exec when a required target is already damaged", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("damaged-exec-target-save");
    const job = authorityStore.jobs[0];
    job.payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read", "exec"],
    };
    job.toolsAllowExecTarget = { version: 1, host: "gateway", ask: "always" };
    job.toolsAllowExecTargetRequirement = { version: 1, recoveryRequired: true };

    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const stored = JSON.parse(row.job_json) as { payload: { toolsAllow?: string[] } };
    expect(stored.payload.toolsAllow).toEqual(["read"]);
    const reloaded = (await loadCronStore(storePath)).jobs[0];
    expect(reloaded?.payload.toolsAllow).toEqual(["read"]);
    expect(reloaded?.toolsAllowExecTargetRequirement).toEqual({
      version: 1,
      recoveryRequired: true,
    });
  });

  it("retires authority when an older writer changes its tool cap", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("downgrade-cap-change");
    const job = authorityStore.jobs[0];
    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    database
      .prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload.toolsAllow', json(?), '$.payload.toolsAllowIsDefault', json('false')) WHERE job_id = ?",
      )
      .run(JSON.stringify(["read"]), job.id);

    const drifted = (await loadCronStore(storePath)).jobs[0];
    expect(drifted?.runtimeAuthority).toBeUndefined();
    expect(drifted?.runtimeAuthorityRecoveryRequired).toBe(true);
    expect(
      database
        .prepare("SELECT recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?")
        .get(job.id),
    ).toEqual({ recovery_required: 1 });

    // Reverting the visible cap cannot revive the retired envelope.
    database
      .prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload.toolsAllow', json(?), '$.payload.toolsAllowIsDefault', json('true')) WHERE job_id = ?",
      )
      .run(JSON.stringify(["read", "cron"]), job.id);
    const reverted = (await loadCronStore(storePath)).jobs[0];
    expect(reverted?.runtimeAuthority).toBeUndefined();
    expect(reverted?.runtimeAuthorityRecoveryRequired).toBe(true);
  });

  it("fails closed and durably recovers malformed authority rows", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("malformed-authority-row");
    const job = authorityStore.jobs[0];
    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    database
      .prepare("UPDATE cron_job_runtime_authorities SET authority_json = ? WHERE job_id = ?")
      .run("{not-json", job.id);

    const loaded = (await loadCronStore(storePath)).jobs[0];
    expect(loaded?.runtimeAuthority).toBeUndefined();
    expect(loaded?.runtimeAuthorityRecoveryRequired).toBe(true);
    expect(
      database
        .prepare(
          "SELECT authority_json, authority_input_fingerprint, recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?",
        )
        .get(job.id),
    ).toEqual({
      authority_json: null,
      authority_input_fingerprint: null,
      recovery_required: 1,
    });
  });

  it("atomically rolls back parent changes when authority persistence fails", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("authority-atomic-write");
    const job = authorityStore.jobs[0];
    await saveCronStore(storePath, authorityStore);

    const database = openOpenClawStateDatabase().db;
    database.exec(`
      CREATE TRIGGER reject_cron_runtime_authority_update
      BEFORE UPDATE ON cron_job_runtime_authorities
      BEGIN
        SELECT RAISE(ABORT, 'authority write rejected');
      END;
    `);
    const changed = structuredClone(authorityStore);
    changed.jobs[0].description = "must roll back";

    try {
      await expect(saveCronStore(storePath, changed)).rejects.toThrow("authority write rejected");
    } finally {
      database.exec("DROP TRIGGER reject_cron_runtime_authority_update;");
    }

    const loaded = (await loadCronStore(storePath)).jobs[0];
    expect(loaded?.description).toBeUndefined();
    expect(loaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
  });

  it("cascades authority deletion and permits a fresh recapture", async () => {
    const { storePath } = await makeStorePath();
    const authorityStore = makeAuthorityStore("authority-lifecycle");
    const job = authorityStore.jobs[0];
    await saveCronStore(storePath, authorityStore);

    const recoveryStore = structuredClone(authorityStore);
    const recoveryJob = recoveryStore.jobs[0];
    delete recoveryJob.runtimeAuthority;
    recoveryJob.runtimeAuthorityRecoveryRequired = true;
    await saveCronStore(storePath, recoveryStore);
    expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthorityRecoveryRequired).toBe(true);

    const recapturedStore = structuredClone(authorityStore);
    const recapturedJob = recapturedStore.jobs[0];
    recapturedJob.runtimeAuthority = {
      ...expectDefined(job.runtimeAuthority, "original runtime authority test invariant"),
      payload: { apps: [{ id: "mail" }] },
    };
    delete recapturedJob.runtimeAuthorityRecoveryRequired;
    await saveCronStore(storePath, recapturedStore);
    expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthority).toEqual(
      recapturedJob.runtimeAuthority,
    );

    await saveCronStore(storePath, { version: 1, jobs: [] });
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT job_id FROM cron_job_runtime_authorities WHERE job_id = ?")
        .get(job.id),
    ).toBeUndefined();
  });

  it("does not persist a default-cap flag for an explicit toolsAllow restriction", async () => {
    // An explicit user restriction is fail-closed: it carries no flag, so a CLI
    // run still surfaces the prepare.ts rejection rather than silently dropping
    // the requested policy.
    const store = await makeStorePath();
    const payload = makeStore("tools-allow-explicit-job", true);
    payload.jobs[0].sessionTarget = "isolated";
    payload.jobs[0].payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read"],
    };

    await saveCronStore(store.storePath, payload);

    const reloaded = (await loadCronStore(store.storePath)).jobs[0]?.payload;
    expect(reloaded).toMatchObject({ kind: "agentTurn", toolsAllow: ["read"] });
    expect(reloaded && "toolsAllowIsDefault" in reloaded).toBe(false);
  });
});

describe("cron jobs fingerprint guard", () => {
  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "fingerprints one raw definition snapshot independently of %s storage",
    async (encoding) => {
      await withOpenClawTestState({ label: "cron-fingerprint" }, async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        await fs.mkdir(path.dirname(databasePath), { recursive: true });
        const initial = new DatabaseSync(databasePath);
        try {
          // SQLite fixes file encoding at the first schema write, even after that table is removed.
          initial.exec(
            `PRAGMA encoding = '${encoding}'; CREATE TABLE fixture(id); DROP TABLE fixture;`,
          );
        } finally {
          initial.close();
        }
        const storePath = state.statePath("cron", "jobs.json");
        const jobs = ["z", "\u{10000}", "\ue000", "malformed"].map(
          (id) => makeStore(id, true).jobs[0],
        );
        await saveCronStore(storePath, { version: 1, jobs });
        const db = openOpenClawStateDatabase().db;
        expect(db.prepare("PRAGMA encoding").get()).toEqual({ encoding });
        const storeKey = cronStoreKey(storePath);
        db.prepare(
          "UPDATE cron_jobs SET job_json = '{malformed' WHERE store_key = ? AND job_id = ?",
        ).run(storeKey, "malformed");
        const raw = db
          .prepare(
            "SELECT job_id, job_json, sort_order FROM cron_jobs WHERE store_key = ? ORDER BY job_id",
          )
          .all(storeKey);
        const expectedOrder = ["malformed", "z", "\ue000", "\u{10000}"].map((id) =>
          expectDefined(
            raw.find((row) => row.job_id === id),
            "raw fingerprint row",
          ),
        );
        const fingerprint = createHash("sha256")
          .update(JSON.stringify(expectedOrder))
          .digest("hex");
        const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
        const reads = trackSqliteStatementExecutions(db, ["jobs"], (sql) =>
          sql.startsWith("select ") && sql.includes('from "cron_jobs"') ? "jobs" : null,
        );
        try {
          expect(loadCronStoreFromDatabase(db, storeKey).store).toEqual(loaded.store);
          expect(loaded.jobsFingerprint).toBe(fingerprint);
          expect(loaded.store.jobs.map((job) => job.id)).toEqual(["z", "\u{10000}", "\ue000"]);
          expect(loaded.invalidConfigRows).toHaveLength(1);
          expect(reads.rowCounts.jobs).toBe(4);
          expect(reads.counts.jobs).toBe(1);
        } finally {
          reads.restore();
        }
        db.prepare("UPDATE cron_jobs SET state_json = ? WHERE store_key = ? AND job_id = ?").run(
          '{"lastRunAtMs":42}',
          storeKey,
          "z",
        );
        expect(() => assertCronJobsStoreUnchanged(db, storePath, fingerprint)).not.toThrow();
        db.prepare(
          "UPDATE cron_jobs SET sort_order = sort_order + 1 WHERE store_key = ? AND job_id = ?",
        ).run(storeKey, "z");
        expect(() => assertCronJobsStoreUnchanged(db, storePath, fingerprint)).toThrow(
          CronJobsStoreChangedError,
        );
      });
    },
  );

  it("refuses a replace after a concurrent order change and accepts a fresh snapshot", async () => {
    const { storePath } = await makeStorePath();
    const jobA = makeStore("job-a", true).jobs[0];
    const jobB = makeStore("job-b", true).jobs[0];
    await saveCronStore(storePath, { version: 1, jobs: [jobA, jobB] });
    const staleFingerprint = expectDefined(
      (await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint,
      "fingerprint after first save",
    );
    await saveCronStore(storePath, { version: 1, jobs: [jobB, jobA] });

    await expect(
      saveCronJobsStore(
        storePath,
        { version: 1, jobs: [jobA, jobB] },
        {
          transactionHooks: {
            beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, staleFingerprint),
          },
        },
      ),
    ).rejects.toBeInstanceOf(CronJobsStoreChangedError);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["job-b", "job-a"]);

    const freshFingerprint = expectDefined(
      (await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint,
      "fingerprint after concurrent reorder",
    );
    expect(freshFingerprint).not.toBe(staleFingerprint);
    await saveCronJobsStore(
      storePath,
      { version: 1, jobs: [jobA, jobB] },
      {
        transactionHooks: {
          beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, freshFingerprint),
        },
      },
    );
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
  });

  it("preserves concurrent runtime state and authority through a definition repair", async () => {
    const { storePath } = await makeStorePath();
    const store = makeAuthorityStore("job-a");
    await saveCronStore(storePath, store);
    const fingerprint = expectDefined(
      (await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint,
      "fingerprint before runtime commit",
    );
    const concurrent = structuredClone(store);
    const seeded = concurrent.jobs[0];
    const runAtMs = seeded.updatedAtMs + 5_000;
    seeded.updatedAtMs = runAtMs;
    seeded.state = {
      queuedAtMs: runAtMs,
      runningAtMs: runAtMs,
      lastRunAtMs: runAtMs,
      lastRunStatus: "ok",
      consecutiveErrors: 0,
    };
    seeded.runtimeAuthority = {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "mail" }] },
    };
    await saveCronStore(storePath, concurrent);

    expect((await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint).toBe(fingerprint);
    const repair = structuredClone(store);
    repair.jobs[0].enabled = false;
    await saveCronJobsStore(storePath, repair, {
      preserveRuntimeState: true,
      transactionHooks: {
        beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, fingerprint),
      },
    });

    const repaired = expectDefined((await loadCronStore(storePath)).jobs[0], "repaired job");
    expect(repaired.enabled).toBe(false);
    expect(repaired.state).toMatchObject({
      queuedAtMs: runAtMs,
      runningAtMs: runAtMs,
      lastRunAtMs: runAtMs,
      lastRunStatus: "ok",
    });
    expect(repaired.updatedAtMs).toBe(runAtMs);
    expect(repaired.runtimeAuthority).toEqual(seeded.runtimeAuthority);
  });

  it("requires authority recovery when a repair changes its authorization inputs", async () => {
    const { storePath } = await makeStorePath();
    const store = makeAuthorityStore("job-a");
    await saveCronStore(storePath, store);
    const fingerprint = expectDefined(
      (await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint,
      "fingerprint before authority recapture",
    );
    const concurrent = structuredClone(store);
    const concurrentJob = concurrent.jobs[0];
    concurrentJob.runtimeAuthority = {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "mail" }] },
    };
    await saveCronStore(storePath, concurrent);
    const repair = structuredClone(store);
    repair.jobs[0].payload = {
      kind: "agentTurn",
      message: "scheduled continuation",
      toolsAllow: ["read"],
    };

    await saveCronJobsStore(storePath, repair, {
      preserveRuntimeState: true,
      transactionHooks: {
        beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, fingerprint),
      },
    });

    const repaired = expectDefined((await loadCronStore(storePath)).jobs[0], "repaired job");
    expect(repaired.runtimeAuthority).toBeUndefined();
    expect(repaired.runtimeAuthorityRecoveryRequired).toBe(true);
  });

  it("preserves a concurrent runtime authority clear", async () => {
    const { storePath } = await makeStorePath();
    const store = makeAuthorityStore("job-a");
    await saveCronStore(storePath, store);
    const fingerprint = expectDefined(
      (await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint,
      "fingerprint before authority clear",
    );
    const cleared = structuredClone(store);
    const clearedJob = cleared.jobs[0];
    delete clearedJob.runtimeAuthority;
    delete clearedJob.runtimeAuthorityRecoveryRequired;
    await saveCronStore(storePath, cleared);
    const repair = structuredClone(store);
    repair.jobs[0].enabled = false;

    await saveCronJobsStore(storePath, repair, {
      preserveRuntimeState: true,
      transactionHooks: {
        beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, fingerprint),
      },
    });

    const repaired = expectDefined((await loadCronStore(storePath)).jobs[0], "repaired job");
    expect(repaired.enabled).toBe(false);
    expect(repaired.runtimeAuthority).toBeUndefined();
    expect(repaired.runtimeAuthorityRecoveryRequired).toBeUndefined();
  });

  it("migrates authority embedded by an older writer during a preserved repair", async () => {
    const { storePath } = await makeStorePath();
    const store = makeAuthorityStore("legacy-authority-job");
    const job = store.jobs[0];
    await saveCronStore(storePath, store);
    const database = openOpenClawStateDatabase().db;
    const row = database.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").get(job.id) as {
      job_json: string;
    };
    const legacyJob = JSON.parse(row.job_json) as Record<string, unknown>;
    legacyJob.runtimeAuthority = job.runtimeAuthority;
    database
      .prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
      .run(JSON.stringify(legacyJob), job.id);
    database.prepare("DELETE FROM cron_job_runtime_authorities WHERE job_id = ?").run(job.id);
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const fingerprint = expectDefined(loaded.jobsFingerprint, "legacy authority fingerprint");

    await saveCronJobsStore(storePath, loaded.store, {
      preserveRuntimeState: true,
      transactionHooks: {
        beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, fingerprint),
      },
    });

    expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthority).toEqual(
      job.runtimeAuthority,
    );
    const parent = database
      .prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as {
      job_json: string;
    };
    expect(JSON.parse(parent.job_json)).not.toHaveProperty("runtimeAuthority");
  });

  it("still writes runtime state for a full replace that does not opt into preservation", async () => {
    const { storePath } = await makeStorePath();
    const store = makeStore("job-a", true);
    await saveCronStore(storePath, store);
    const seeded = store.jobs[0];
    seeded.state = { runningAtMs: seeded.updatedAtMs };
    await saveCronStore(storePath, store, { stateOnly: true });

    await saveCronStore(storePath, makeStore("job-a", false));

    const replaced = expectDefined((await loadCronStore(storePath)).jobs[0], "replaced job");
    expect(replaced.state.runningAtMs).toBeUndefined();
  });
});
