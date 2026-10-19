import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  loadCronStore,
  resolveCronStorePath,
  saveCronJobsStore,
  saveCronStore,
} from "./store.js";
import { createStorePathFixture, expectPathMissing, makeStore } from "./store.test-support.js";
import { cronStoreKey } from "./store/key.js";
import type { CronStoreFile } from "./types.js";

const makeStorePath = createStorePathFixture();

const requireRecord = createRequireRecord("record", "expected-label");

async function fixture(id: string, enabled = true) {
  const { storePath } = await makeStorePath();
  const payload = makeStore(id, enabled);
  return { storePath, payload, job: payload.jobs[0] };
}

async function expectNoLegacyFiles(paths: string[]) {
  for (const file of paths) {
    await expectPathMissing(file);
  }
}

describe("resolveCronStorePath", () => {
  const envSnapshot = captureEnv(["OPENCLAW_HOME", "HOME"]);

  afterEach(() => {
    envSnapshot.restore();
  });

  it("uses OPENCLAW_HOME for tilde expansion", () => {
    setTestEnvValue("OPENCLAW_HOME", "/srv/openclaw-home");
    setTestEnvValue("HOME", "/home/other");

    const result = resolveCronStorePath("~/cron/jobs.json");
    expect(result).toBe(path.resolve("/srv/openclaw-home", "cron", "jobs.json"));
  });
});

describe("cron store", () => {
  it("reads an absent cron table without touching source WAL artifacts", async () => {
    await withOpenClawTestState({ prefix: "openclaw-cron-readonly-wal-" }, async (state) => {
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const writer = new DatabaseSync(databasePath);
      writer.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('committed');",
      );
      const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
      const hashes = () =>
        Promise.all(
          files.map(async (file) =>
            createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex"),
          ),
        );
      const before = await hashes();
      try {
        const loaded = await withArtifactPreservingStateReads(() =>
          loadCronJobsStoreWithConfigJobsReadOnly(
            path.join(state.stateDir, "cron", "jobs.json"),
            state.env,
          ),
        );
        expect(loaded.store).toEqual({ version: 1, jobs: [] });
        expect(await hashes()).toEqual(before);
        expect(writer.prepare("SELECT value FROM marker").all()).toEqual([{ value: "committed" }]);
      } finally {
        writer.close();
      }
    });
  });

  it("returns empty store when file does not exist", async () => {
    const store = await makeStorePath();
    const loaded = await loadCronStore(store.storePath);
    expect(loaded).toEqual({ version: 1, jobs: [] });
  });

  it.each([
    {
      name: "one-shot schedule without delivery",
      schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
      delivery: { mode: "none" },
      failureAlert: false,
    },
    {
      name: "interval schedule with an explicitly empty failure alert",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_000 },
      delivery: { mode: "announce", channel: "telegram", threadId: 42 },
      failureAlert: {},
    },
    {
      name: "cron schedule with webhook delivery and populated failure alert",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC", staggerMs: 0 },
      delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      failureAlert: { after: 3, cooldownMs: 60_000, includeSkipped: true },
    },
    {
      name: "process-exit schedule with explicit failure destination clears",
      schedule: { kind: "on-exit", command: "./watch.sh", cwd: "/repo" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        failureDestination: { channel: undefined, to: "slack:C123", accountId: undefined },
      },
      failureAlert: { channel: "slack", to: "slack:C123", mode: "announce" },
    },
    {
      name: "stream schedule with completion webhook",
      schedule: {
        kind: "stream",
        command: ["node", "events.mjs"],
        mode: "match",
        match: "^ready:",
        batchMs: 100,
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:chat",
        threadId: "topic-9",
        accountId: "bot-1",
        bestEffort: true,
        completionDestination: { mode: "webhook", to: "https://example.invalid/complete" },
      },
      failureAlert: { accountId: "bot-1", mode: "webhook" },
    },
    ...(["email", "webhook"] as const).map((externalContentSource) => ({
      name: `${externalContentSource} provenance`,
      payload: {
        kind: "agentTurn" as const,
        message: "Summarize hook payload",
        externalContentSource,
      },
    })),
    {
      name: "command payload and tool cap",
      payload: {
        kind: "command",
        argv: ["sh", "-lc", 'printf %s "$1"', "  "],
        cwd: "/srv/example",
        env: { FOO: "bar" },
        input: "stdin",
        timeoutSeconds: 45,
        noOutputTimeoutSeconds: 10,
        outputMaxBytes: 4096,
        toolsAllow: ["read", "cron"],
        toolsAllowIsDefault: true,
      },
    },
    {
      name: "trigger-script systemEvent tool cap",
      sessionTarget: "main",
      trigger: { script: "return { fire: false }" },
      payload: {
        kind: "systemEvent",
        text: "changed",
        toolsAllow: ["read", "cron"],
        toolsAllowIsDefault: true,
      },
    },
    ...["1737500000.123456", "007"].map((threadId) => ({
      name: `numeric-looking string thread ${threadId}`,
      delivery: { mode: "announce" as const, channel: "telegram", to: "telegram:chat-1", threadId },
    })),
  ] satisfies Array<{ name: string } & Partial<CronStoreFile["jobs"][number]>>)(
    "preserves the complete job for $name",
    async ({ name, ...overrides }) => {
      const { storePath, payload, job } = await fixture(name);
      Object.assign(
        job,
        { sessionTarget: "isolated", payload: { kind: "agentTurn", message: "run" } },
        overrides,
      );
      await saveCronStore(storePath, payload);
      expect((await loadCronStore(storePath)).jobs[0]).toStrictEqual(job);
    },
  );

  it("runs post-commit hooks only after the cron write commits", async () => {
    const { storePath, payload: store } = await fixture("post-commit-hook");
    const afterCommit = vi.fn();
    await saveCronJobsStore(storePath, store, { transactionHooks: { afterCommit } });
    expect(afterCommit).toHaveBeenCalledOnce();

    const database = openOpenClawStateDatabase().db;
    database.exec(
      "CREATE TEMP TRIGGER reject_cron_post_commit BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, 'cron update rejected'); END",
    );
    try {
      await expect(
        saveCronJobsStore(storePath, store, { transactionHooks: { afterCommit } }),
      ).rejects.toThrow("cron update rejected");
      expect(afterCommit).toHaveBeenCalledOnce();
    } finally {
      database.exec("DROP TRIGGER reject_cron_post_commit");
    }
  });

  it("keeps valid cron row metadata aligned when an earlier SQLite row is malformed", async () => {
    const { storePath } = await makeStorePath();
    const malformed = makeStore("malformed-first", true).jobs[0];
    const surviving = makeStore("surviving-second", true).jobs[0];
    surviving.state = { nextRunAtMs: 987_654 };
    await saveCronStore(storePath, { version: 1, jobs: [malformed, surviving] });
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.kind', ?) WHERE store_key = ? AND job_id = ?",
      )
      .run("unsupported", path.resolve(storePath), malformed.id);

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);

    expect(loaded.store.jobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(loaded.configJobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(loaded.configJobIndexes).toEqual([1]);
    expect(loaded.configJobRuntimeEntries[0]?.state?.nextRunAtMs).toBe(987_654);
    expect(loaded.invalidConfigRows).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: expect.objectContaining({ id: malformed.id }),
      }),
    ]);
  });

  it("rejects alias-only job identities without replacing existing rows", async () => {
    await withOpenClawTestState({ label: "cron-canonical-identity" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      const store = makeStore("retained", true);
      await saveCronStore(storePath, store);
      const database = openOpenClawStateDatabase().db;
      const rows = () =>
        database
          .prepare("SELECT * FROM cron_jobs WHERE store_key = ? ORDER BY job_id")
          .all(cronStoreKey(storePath));
      const before = rows();
      const aliasOnly = { ...makeStore("alias-only", true).jobs[0], jobId: "alias-only" };
      Reflect.deleteProperty(aliasOnly, "id");

      await expect(
        saveCronStore(storePath, {
          version: 1,
          jobs: [{ ...store.jobs[0], name: "must not change" }, aliasOnly],
        }),
      ).rejects.toThrow("Cannot persist cron store with 1 invalid job(s)");

      expect(rows()).toEqual(before);
    });
  });

  it("replaces cron jobs in SQLite without rewriting legacy files", async () => {
    const store = await makeStorePath();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);

    expectDefined(first.jobs[0], "prior job").description = "x".repeat(128 * 1024);
    await saveCronStore(store.storePath, first);
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
      ["priorRows"],
      (sql) => (/^select\b/i.test(sql) && sql.includes('"cron_jobs"') ? "priorRows" : null),
    );
    try {
      await saveCronStore(store.storePath, second);
      expect(counter.textBytes.priorRows).toBeLessThan(1024);
    } finally {
      counter.restore();
    }

    const loaded = await loadCronStore(store.storePath);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-2"]);
    await expectNoLegacyFiles([store.storePath, `${store.storePath}.bak`]);
  });

  it.each([
    { order: ["new", "legacy", "healthy"] },
    { order: ["legacy", "new", "healthy"] },
    { order: ["legacy", "healthy", "new"] },
    { order: ["healthy", "new", "legacy"] },
  ])("honors replacement order $order without repairing an unsupported row", async ({ order }) => {
    const { storePath } = await makeStorePath();
    const first = expectDefined(makeStore("legacy", true).jobs[0], "legacy fixture");
    const second = expectDefined(makeStore("healthy", true).jobs[0], "healthy fixture");
    await saveCronStore(storePath, { version: 1, jobs: [first, second] });
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery', json(?)), sort_order = 10 WHERE store_key = ? AND job_id = 'legacy'",
    ).run(JSON.stringify({ mode: "unsupported", to: "authored-target" }), cronStoreKey(storePath));
    db.prepare(
      "UPDATE cron_jobs SET sort_order = 20 WHERE store_key = ? AND job_id = 'healthy'",
    ).run(cronStoreKey(storePath));
    const retained = () => {
      const { sort_order: _sortOrder, ...row } = expectDefined(
        db
          .prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = 'legacy'")
          .get(cronStoreKey(storePath)),
        "stored legacy row",
      );
      return row;
    };
    const before = retained();
    const loaded = await loadCronStore(storePath);
    const jobsById = new Map(loaded.jobs.map((job) => [job.id, job]));
    jobsById.set("new", expectDefined(makeStore("new", true).jobs[0], "new fixture"));
    await expect(
      saveCronStore(storePath, {
        version: 1,
        jobs: order.map((id) => expectDefined(jobsById.get(id), "replacement fixture")),
      }),
    ).resolves.toBeUndefined();
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(order);
    expect(retained()).toEqual(before);
  });

  it("persists runtime-only state churn and idempotent saves without legacy files", async () => {
    const { storePath, payload, job } = await fixture("job-1");
    await saveCronStore(storePath, payload);
    job.updatedAtMs += 60_000;
    job.state = { nextRunAtMs: job.createdAtMs + 60_000, lastRunAtMs: job.createdAtMs + 30_000 };
    await saveCronStore(storePath, payload);
    await loadCronStore(storePath);
    await saveCronStore(storePath, payload);
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject(job.state);
    await expectNoLegacyFiles([
      storePath,
      storePath.replace(/\.json$/, "-state.json"),
      `${storePath}.bak`,
    ]);
  });

  it("round-trips the auto-disable reason through runtime state JSON", async () => {
    const { storePath, payload, job } = await fixture("auto-disabled-job", false);
    await saveCronStore(storePath, payload);

    job.state = {
      consecutiveErrors: 10,
      autoDisabled: {
        reason: "consecutive-failures",
        atMs: job.updatedAtMs,
        consecutiveErrors: 10,
      },
    };
    await saveCronStore(storePath, payload, { stateOnly: true });

    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject(job.state);
  });

  it("normalizes legacy run-status aliases into canonical runtime state JSON", async () => {
    const { storePath, payload, job } = await fixture("legacy-run-status");
    job.state = { lastStatus: "ok" };

    await saveCronStore(storePath, payload);
    expect((await loadCronStore(storePath)).jobs[0]?.state).toEqual({
      lastStatus: "ok",
      lastRunStatus: "ok",
    });

    job.state = { lastStatus: "error" };
    await saveCronStore(storePath, payload, { stateOnly: true });
    expect((await loadCronStore(storePath)).jobs[0]?.state).toEqual({
      lastStatus: "error",
      lastRunStatus: "error",
    });
  });

  it("stores queued reservations separately from active run markers", async () => {
    const { storePath, payload, job } = await fixture("job-queued-phase");
    job.state = {
      nextRunAtMs: job.createdAtMs,
      startupCatchupAtMs: job.createdAtMs,
      pacedNextRunAtMs: job.createdAtMs,
      queuedAtMs: job.createdAtMs + 1,
    };

    await saveCronStore(storePath, payload);

    const queuedRow = openOpenClawStateDatabase()
      .db.prepare("SELECT state_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { state_json: string };
    const queuedState = JSON.parse(queuedRow.state_json) as Record<string, unknown>;
    expect(queuedState.runningAtMs).toBeUndefined();
    const queued = {
      queuedAtMs: job.createdAtMs + 1,
      startupCatchupAtMs: job.createdAtMs,
      pacedNextRunAtMs: job.createdAtMs,
    };
    expect(queuedState).toMatchObject(queued);
    expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject(queued);

    job.state.queuedAtMs = undefined;
    job.state.runningAtMs = job.createdAtMs + 2;
    await saveCronStore(storePath, payload, { stateOnly: true });

    const activated = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(activated?.queuedAtMs).toBeUndefined();
    expect(activated?.runningAtMs).toBe(job.createdAtMs + 2);
  });

  it("updates runtime state without replacing concurrent cron config", async () => {
    const { storePath, payload: stale, job } = await fixture("job-state-only");
    await saveCronStore(storePath, stale);
    const current: CronStoreFile = {
      version: 1,
      jobs: [
        {
          ...job,
          name: "Job current",
          updatedAtMs: job.updatedAtMs + 1,
        },
        makeStore("job-added-concurrently", true).jobs[0],
      ],
    };
    job.state = { nextRunAtMs: job.createdAtMs + 60_000 };
    job.updatedAtMs += 2;
    await saveCronStore(storePath, current);
    await saveCronStore(storePath, stale, { stateOnly: true });
    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs.map((entry) => entry.id)).toEqual([
      "job-state-only",
      "job-added-concurrently",
    ]);
    expect(loaded.jobs[0]?.name).toBe("Job current");
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(job.createdAtMs + 60_000);
  });

  it("preserves distinct numeric and string thread identities in canonical cron job JSON", async () => {
    const { storePath } = await makeStorePath();
    const numberJob = makeStore("sqlite-thread-id-number", true).jobs[0];
    numberJob.delivery = { mode: "announce", channel: "telegram", to: "telegram:a", threadId: 42 };
    const stringJob = makeStore("sqlite-thread-id-string", true).jobs[0];
    stringJob.delivery = { ...numberJob.delivery, to: "telegram:b", threadId: "42" };

    await saveCronStore(storePath, { version: 1, jobs: [numberJob, stringJob] });

    const jobs = (await loadCronStore(storePath)).jobs;
    expect(jobs[0]?.delivery?.threadId).toBe(42);
    expect(typeof jobs[0]?.delivery?.threadId).toBe("number");
    expect(jobs[1]?.delivery?.threadId).toBe("42");
    expect(typeof jobs[1]?.delivery?.threadId).toBe("string");
  });

  it("round-trips explicit failure destination field clears through canonical cron job JSON", async () => {
    const { storePath } = await makeStorePath();
    const job = makeStore("sqlite-failure-destination-clear-job", true).jobs[0];
    job.sessionTarget = "isolated";
    job.payload = { kind: "agentTurn", message: "hello" };
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "telegram:chat-1",
      failureDestination: {
        channel: undefined,
        to: "slack:C123",
        accountId: undefined,
        mode: undefined,
      },
    };

    await saveCronStore(storePath, { version: 1, jobs: [job] });

    const row = openOpenClawStateDatabase()
      .db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
      .get(job.id) as { job_json: string };
    expect(JSON.parse(row.job_json).delivery.failureDestination).toEqual({
      channel: null,
      to: "slack:C123",
      accountId: null,
      mode: null,
    });

    const delivery = (await loadCronStore(storePath)).jobs[0]?.delivery;
    expect(delivery?.failureDestination).toStrictEqual(job.delivery.failureDestination);

    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const configDelivery = requireRecord(loaded.configJobs[0]?.delivery, "config delivery");
    const configFailureDestination = requireRecord(
      configDelivery.failureDestination,
      "config failure destination",
    );
    for (const key of ["channel", "accountId", "mode"]) {
      expect(Object.hasOwn(configFailureDestination, key)).toBe(true);
    }
  });

  it("keeps custom store paths separated by SQLite store key", async () => {
    const store = await makeStorePath();
    const storePath = store.storePath.replace(/\.json$/, "");
    const payload = makeStore("job-1", true);
    const job = payload.jobs[0];
    await saveCronStore(storePath, payload);
    job.updatedAtMs += 60_000;
    job.state = { nextRunAtMs: job.createdAtMs + 60_000 };
    await saveCronStore(storePath, payload);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(
      job.createdAtMs + 60_000,
    );
    await expectNoLegacyFiles([storePath, `${storePath}-state.json`]);
  });
});
