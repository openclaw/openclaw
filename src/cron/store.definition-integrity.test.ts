import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
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
type Job = Parameters<typeof saveCronStore>[1]["jobs"][number];
const EXEC_TARGET = { version: 1, host: "gateway", ask: "always" } as const;

function turn(toolsAllow: string[], toolsAllowIsDefault?: true): Job["payload"] {
  return {
    kind: "agentTurn",
    message: "scheduled continuation",
    toolsAllow,
    ...(toolsAllowIsDefault ? { toolsAllowIsDefault } : {}),
  };
}

function authority(app: string): NonNullable<Job["runtimeAuthority"]> {
  return {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: { apps: [{ id: app }] },
  };
}

function readDefinition(jobId: string): Record<string, unknown> {
  const row = openOpenClawStateDatabase()
    .db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
    .get(jobId) as { job_json: string };
  return JSON.parse(row.job_json);
}

function writeDefinition(jobId: string, value: Record<string, unknown>) {
  openOpenClawStateDatabase()
    .db.prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?")
    .run(JSON.stringify(value), jobId);
}

async function savedAuthority(jobId: string, overrides: Partial<Job> = {}) {
  const { storePath } = await makeStorePath();
  const store = makeAuthorityStore(jobId);
  Object.assign(store.jobs[0], overrides);
  await saveCronStore(storePath, store);
  return { storePath, store, job: store.jobs[0], database: openOpenClawStateDatabase().db };
}

async function loadFingerprint(storePath: string) {
  return expectDefined(
    (await loadCronJobsStoreWithConfigJobs(storePath)).jobsFingerprint,
    "persisted definition fingerprint",
  );
}

function saveGuarded(
  storePath: string,
  store: Parameters<typeof saveCronJobsStore>[1],
  expected: string,
  options: Parameters<typeof saveCronJobsStore>[2] = {},
) {
  return saveCronJobsStore(storePath, store, {
    ...options,
    transactionHooks: {
      beforeWrite: (db) => assertCronJobsStoreUnchanged(db, storePath, expected),
    },
  });
}

function makeAuthorityStore(jobId: string) {
  const store = makeStore(jobId, true);
  const job = store.jobs[0];
  job.owner = {
    agentId: "main",
    sessionKey: "agent:main:discord:group:ops",
    accountId: "work",
  };
  job.sessionTarget = "isolated";
  job.payload = turn(["read", "cron"], true);
  job.scheduledToolPolicy = {
    version: 1,
    mode: "account",
    ownerSessionKey: "agent:main:discord:group:ops",
    ownerAccountId: "work",
  };
  job.toolsAllowProvenance = { version: 1, source: "final-executable-surface" };
  job.runtimeAuthority = authority("calendar");
  return store;
}

it("preserves separately stored authority through reads and older-writer edits", async () => {
  const { storePath, job, database } = await savedAuthority("authority-companion-row", {
    createdActor: { type: "human", source: "profile", id: "legacy-owner" },
  });
  const parentJson = readDefinition(job.id);
  expect(parentJson).not.toHaveProperty("ownerProfileId");
  expect(parentJson).not.toHaveProperty("runtimeAuthority");
  expect(parentJson).not.toHaveProperty("runtimeAuthorityRecoveryRequired");
  const child = database
    .prepare("SELECT authority_json FROM cron_job_runtime_authorities WHERE job_id = ?")
    .get(job.id) as { authority_json: string };
  expect(JSON.parse(child.authority_json)).toEqual(job.runtimeAuthority);

  const reloaded = (await loadCronStore(storePath)).jobs[0];
  expect(reloaded?.payload).toStrictEqual(job.payload);
  expect(reloaded?.ownerProfileId).toBe("legacy-owner");
  expect(reloaded).not.toHaveProperty("ownerTransferPending");
  expect(reloaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
  expect(reloaded?.runtimeAuthorityRecoveryRequired).toBeUndefined();
  const readOnly = (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs[0];
  expect(readOnly?.runtimeAuthority).toEqual(job.runtimeAuthority);
  const downgradedJob = { ...parentJson, description: "edited by an older build" };
  database
    .prepare("UPDATE cron_jobs SET description = ?, job_json = ? WHERE job_id = ?")
    .run("edited by an older build", JSON.stringify(downgradedJob), job.id);

  const downgraded = (await loadCronStore(storePath)).jobs[0];
  expect(downgraded?.description).toBe("edited by an older build");
  expect(downgraded?.runtimeAuthority).toEqual(job.runtimeAuthority);
  expect(downgraded?.runtimeAuthorityRecoveryRequired).toBeUndefined();
});

it("round-trips the restrict-only exec target and drops foreign shapes", async () => {
  const target = EXEC_TARGET;
  const required = { version: 1, target, grantIndex: 0 } as const;
  const { storePath, job } = await savedAuthority("exec-target-round-trip", {
    payload: turn(["exec", "read"]),
    toolsAllowExecTarget: target,
    toolsAllowExecTargetRequirement: required,
  });
  const reloaded = (await loadCronStore(storePath)).jobs[0];
  expect(reloaded?.payload.toolsAllow).toEqual(["exec", "read"]);
  expect(reloaded?.toolsAllowExecTarget).toEqual(target);
  expect(reloaded?.toolsAllowExecTargetRequirement).toEqual(required);

  const edited = readDefinition(job.id);
  expect((edited.payload as { toolsAllow?: string[] }).toolsAllow).toEqual(["read"]);
  // Damaged or downgraded writers cannot restore broad exec; future keys are tolerated.
  for (const [storedTarget, requirement, expectedTarget, toolsAllow] of [
    [{ version: 1, host: "node" }, required, undefined, ["read"]],
    [undefined, undefined, undefined, ["read"]],
    [{ ...target, note: "future-field" }, required, target, ["exec", "read"]],
    [{ ...target, ask: "off" }, required, { version: 1, host: "gateway" }, ["read"]],
  ] as const) {
    Object.assign(edited, {
      toolsAllowExecTarget: storedTarget,
      toolsAllowExecTargetRequirement: requirement,
    });
    writeDefinition(job.id, edited);
    const restored = (await loadCronStore(storePath)).jobs[0];
    expect({
      target: restored?.toolsAllowExecTarget,
      tools: restored?.payload.toolsAllow,
    }).toEqual({ target: expectedTarget, tools: toolsAllow });
  }
});

it("never stores broad exec when a required target is already damaged", async () => {
  const { storePath, job } = await savedAuthority("damaged-exec-target-save", {
    payload: turn(["read", "exec"]),
    toolsAllowExecTarget: EXEC_TARGET,
    toolsAllowExecTargetRequirement: { version: 1, recoveryRequired: true },
  });
  expect(readDefinition(job.id)).toMatchObject({ payload: { toolsAllow: ["read"] } });
  const reloaded = (await loadCronStore(storePath)).jobs[0];
  expect(reloaded?.payload).toStrictEqual(turn(["read"]));
  expect(reloaded?.toolsAllowExecTargetRequirement).toEqual({
    version: 1,
    recoveryRequired: true,
  });
});

it.each(["tool cap drift", "malformed authority"])(
  "durably retires authority after %s",
  async (defect) => {
    const { storePath, job, database } = await savedAuthority(
      defect === "tool cap drift" ? "cap-drift" : "malformed-authority",
    );
    const updateCap = database.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.payload.toolsAllow', json(?), '$.payload.toolsAllowIsDefault', json(?)) WHERE job_id = ?",
    );
    if (defect === "tool cap drift") {
      updateCap.run(JSON.stringify(["read"]), "false", job.id);
    } else {
      database
        .prepare("UPDATE cron_job_runtime_authorities SET authority_json = ? WHERE job_id = ?")
        .run("{not-json", job.id);
    }
    const loaded = (await loadCronStore(storePath)).jobs[0];
    expect(loaded?.runtimeAuthority).toBeUndefined();
    expect(loaded?.runtimeAuthorityRecoveryRequired).toBe(true);
    expect(
      database
        .prepare(
          "SELECT authority_json, authority_input_fingerprint, recovery_required FROM cron_job_runtime_authorities WHERE job_id = ?",
        )
        .get(job.id),
    ).toEqual({ authority_json: null, authority_input_fingerprint: null, recovery_required: 1 });
    if (defect === "tool cap drift") {
      updateCap.run(JSON.stringify(["read", "cron"]), "true", job.id);
      const reverted = (await loadCronStore(storePath)).jobs[0];
      expect(reverted?.runtimeAuthority).toBeUndefined();
      expect(reverted?.runtimeAuthorityRecoveryRequired).toBe(true);
    }
  },
);

it("atomically rolls back parent changes when authority persistence fails", async () => {
  const { storePath, store, job, database } = await savedAuthority("authority-atomic-write");
  database.exec(
    "CREATE TRIGGER reject_cron_runtime_authority_update BEFORE UPDATE ON cron_job_runtime_authorities BEGIN SELECT RAISE(ABORT, 'authority write rejected'); END;",
  );
  job.description = "must roll back";

  try {
    await expect(saveCronStore(storePath, store)).rejects.toThrow("authority write rejected");
  } finally {
    database.exec("DROP TRIGGER reject_cron_runtime_authority_update;");
  }

  const loaded = (await loadCronStore(storePath)).jobs[0];
  expect(loaded?.description).toBeUndefined();
  expect(loaded?.runtimeAuthority).toEqual(job.runtimeAuthority);
});

it("cascades authority deletion and permits a fresh recapture", async () => {
  const { storePath, store, job, database } = await savedAuthority("authority-lifecycle");
  delete job.runtimeAuthority;
  job.runtimeAuthorityRecoveryRequired = true;
  await saveCronStore(storePath, store);
  expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthorityRecoveryRequired).toBe(true);

  job.runtimeAuthority = authority("mail");
  delete job.runtimeAuthorityRecoveryRequired;
  await saveCronStore(storePath, store);
  expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthority).toEqual(job.runtimeAuthority);

  await saveCronStore(storePath, { version: 1, jobs: [] });
  expect(
    database
      .prepare("SELECT job_id FROM cron_job_runtime_authorities WHERE job_id = ?")
      .get(job.id),
  ).toBeUndefined();
});
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
      const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
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
      const fingerprint = createHash("sha256").update(JSON.stringify(expectedOrder)).digest("hex");
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
  const staleFingerprint = await loadFingerprint(storePath);
  await saveCronStore(storePath, { version: 1, jobs: [jobB, jobA] });

  await expect(
    saveGuarded(storePath, { version: 1, jobs: [jobA, jobB] }, staleFingerprint),
  ).rejects.toBeInstanceOf(CronJobsStoreChangedError);
  expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["job-b", "job-a"]);

  const freshFingerprint = await loadFingerprint(storePath);
  expect(freshFingerprint).not.toBe(staleFingerprint);
  await saveGuarded(storePath, { version: 1, jobs: [jobA, jobB] }, freshFingerprint);
  expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
});

it.each(["preserve", "reauthorize", "clear", "replace"] as const)(
  "reconciles concurrent runtime state during a definition repair (%s)",
  async (mode) => {
    const { storePath, store } = await savedAuthority("job-a");
    const expectedFingerprint = await loadFingerprint(storePath);
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
    seeded.runtimeAuthority = authority("mail");
    if (mode === "clear") {
      delete seeded.runtimeAuthority;
      delete seeded.runtimeAuthorityRecoveryRequired;
    }
    await saveCronStore(storePath, concurrent);
    expect(await loadFingerprint(storePath)).toBe(expectedFingerprint);
    const repair = structuredClone(store);
    repair.jobs[0].enabled = false;
    if (mode === "reauthorize") {
      repair.jobs[0].payload = turn(["read"]);
    }
    await saveGuarded(storePath, repair, expectedFingerprint, {
      preserveRuntimeState: mode !== "replace",
    });
    const repaired = expectDefined((await loadCronStore(storePath)).jobs[0], "repaired job");
    expect(repaired.enabled).toBe(false);
    expect(repaired.state).toEqual(mode === "replace" ? store.jobs[0].state : seeded.state);
    expect(repaired.updatedAtMs).toBe(mode === "replace" ? store.jobs[0].updatedAtMs : runAtMs);
    expect(repaired.runtimeAuthority).toEqual(
      mode === "reauthorize"
        ? undefined
        : mode === "replace"
          ? store.jobs[0].runtimeAuthority
          : seeded.runtimeAuthority,
    );
    expect(repaired.runtimeAuthorityRecoveryRequired).toBe(
      mode === "reauthorize" ? true : undefined,
    );
  },
);

it("migrates authority embedded by an older writer during a preserved repair", async () => {
  const { storePath, job, database } = await savedAuthority("legacy-authority-job");
  const legacyJob = readDefinition(job.id);
  legacyJob.runtimeAuthority = job.runtimeAuthority;
  writeDefinition(job.id, legacyJob);
  database.prepare("DELETE FROM cron_job_runtime_authorities WHERE job_id = ?").run(job.id);
  const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
  const fingerprint = expectDefined(loaded.jobsFingerprint, "legacy authority fingerprint");

  await saveGuarded(storePath, loaded.store, fingerprint, {
    preserveRuntimeState: true,
  });

  expect((await loadCronStore(storePath)).jobs[0]?.runtimeAuthority).toEqual(job.runtimeAuthority);
  expect(readDefinition(job.id)).not.toHaveProperty("runtimeAuthority");
});
