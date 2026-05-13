import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { loadCronStore, loadCronStoreSync, saveCronStore, updateCronStoreJobs } from "./store.js";
import type { CronStoreSnapshot } from "./types.js";

let fixtureRoot = "";
let caseId = 0;
let originalOpenClawStateDir: string | undefined;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-"));
  originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(fixtureRoot, "state");
});

afterAll(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

function makeStoreKey() {
  return {
    storeKey: `case-${caseId++}`,
  };
}

function makeStore(jobId: string, enabled: boolean): CronStoreSnapshot {
  const now = Date.now();
  return {
    version: 1,
    jobs: [
      {
        id: jobId,
        name: `Job ${jobId}`,
        enabled,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `tick-${jobId}` },
        state: {},
      },
    ],
  };
}

function openCronStoreTestDb() {
  const stateDatabase = openOpenClawStateDatabase();
  return {
    stateDatabase,
    db: getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "cron_jobs">>(stateDatabase.db),
  };
}

describe("cron store", () => {
  it("returns empty store when SQLite has no rows for the store key", async () => {
    const { storeKey } = makeStoreKey();
    const loaded = await loadCronStore(storeKey);
    expect(loaded).toEqual({ version: 1, jobs: [] });
  });

  it("persists and round-trips job definitions through SQLite without writing jobs.json", async () => {
    const { storeKey } = makeStoreKey();
    const payload = makeStore("job-1", true);
    payload.jobs[0].state = {
      nextRunAtMs: payload.jobs[0].createdAtMs + 60_000,
    };

    await saveCronStore(storeKey, payload);

    const loaded = await loadCronStore(storeKey);
    expect(loaded.jobs[0]).toMatchObject({
      id: "job-1",
      state: { nextRunAtMs: payload.jobs[0].createdAtMs + 60_000 },
    });
  });

  it("stores hot cron job metadata in typed columns", async () => {
    const { storeKey } = makeStoreKey();
    const store = makeStore("job-hot", true);
    const job = store.jobs[0];
    job.agentId = "main";
    job.sessionKey = "telegram:chat";
    job.delivery = {
      mode: "announce",
      channel: "telegram",
      to: "-100123",
      accountId: "bot-main",
    };
    job.state = {
      nextRunAtMs: job.createdAtMs + 60_000,
      lastRunStatus: "ok",
      lastDeliveryStatus: "delivered",
      lastDelivered: true,
      consecutiveErrors: 0,
    };

    await saveCronStore(storeKey, store);

    const { stateDatabase, db } = openCronStoreTestDb();
    const row = executeSqliteQueryTakeFirstSync(
      stateDatabase.db,
      db
        .selectFrom("cron_jobs")
        .select([
          "name",
          "enabled",
          "agent_id",
          "session_key",
          "schedule_kind",
          "every_ms",
          "session_target",
          "wake_mode",
          "payload_kind",
          "delivery_mode",
          "delivery_channel",
          "delivery_to",
          "delivery_account_id",
          "next_run_at_ms",
          "last_run_status",
          "last_delivery_status",
          "last_delivered",
          "consecutive_errors",
        ])
        .where("store_key", "=", storeKey)
        .where("job_id", "=", "job-hot"),
    );
    expect(row).toMatchObject({
      name: "Job job-hot",
      enabled: 1,
      agent_id: "main",
      session_key: "telegram:chat",
      schedule_kind: "every",
      every_ms: 60_000,
      session_target: "main",
      wake_mode: "next-heartbeat",
      payload_kind: "systemEvent",
      delivery_mode: "announce",
      delivery_channel: "telegram",
      delivery_to: "-100123",
      delivery_account_id: "bot-main",
      next_run_at_ms: job.createdAtMs + 60_000,
      last_run_status: "ok",
      last_delivery_status: "delivered",
      last_delivered: 1,
      consecutive_errors: 0,
    });
  });

  it("loads job definitions from typed columns, not the debug JSON copy", async () => {
    const { storeKey } = makeStoreKey();
    const store = makeStore("job-typed", true);
    store.jobs[0].description = "typed cron job";
    store.jobs[0].deleteAfterRun = true;
    store.jobs[0].payload = {
      kind: "agentTurn",
      message: "run typed cron",
      model: "openai/gpt-5.5",
      fallbacks: ["anthropic/sonnet-4.6"],
      thinking: "low",
      timeoutSeconds: 30,
      allowUnsafeExternalContent: true,
      lightContext: true,
      toolsAllow: ["web_search"],
    };
    store.jobs[0].delivery = {
      mode: "announce",
      channel: "telegram",
      to: "-100123",
      threadId: "99",
      accountId: "bot-main",
      bestEffort: true,
      failureDestination: {
        mode: "webhook",
        channel: "slack",
        to: "#ops",
        accountId: "ops",
      },
    };
    store.jobs[0].failureAlert = {
      after: 3,
      channel: "telegram",
      to: "-100123",
      cooldownMs: 60000,
      includeSkipped: true,
      mode: "announce",
      accountId: "bot-main",
    };
    await saveCronStore(storeKey, store);

    const { stateDatabase, db } = openCronStoreTestDb();
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("cron_jobs")
        .set({ job_json: '{"id":"wrong","enabled":false}' })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", "job-typed"),
    );

    const loaded = await loadCronStore(storeKey);

    expect(loaded.jobs[0]).toMatchObject({
      id: "job-typed",
      description: "typed cron job",
      enabled: true,
      deleteAfterRun: true,
      payload: {
        kind: "agentTurn",
        message: "run typed cron",
        model: "openai/gpt-5.5",
        fallbacks: ["anthropic/sonnet-4.6"],
        thinking: "low",
        timeoutSeconds: 30,
        allowUnsafeExternalContent: true,
        lightContext: true,
        toolsAllow: ["web_search"],
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-100123",
        threadId: "99",
        accountId: "bot-main",
        bestEffort: true,
        failureDestination: {
          mode: "webhook",
          channel: "slack",
          to: "#ops",
          accountId: "ops",
        },
      },
      failureAlert: {
        after: 3,
        channel: "telegram",
        to: "-100123",
        cooldownMs: 60000,
        includeSkipped: true,
        mode: "announce",
        accountId: "bot-main",
      },
    });
  });

  it("loads runtime state from typed columns, not the debug JSON copy", async () => {
    const { storeKey } = makeStoreKey();
    const store = makeStore("job-state-typed", true);
    const job = store.jobs[0];
    job.state = {
      nextRunAtMs: job.createdAtMs + 60_000,
      runningAtMs: job.createdAtMs + 30_000,
      lastRunAtMs: job.createdAtMs + 10_000,
      lastRunStatus: "ok",
      lastError: "typed error",
      lastDurationMs: 123,
      consecutiveErrors: 2,
      consecutiveSkipped: 3,
      scheduleErrorCount: 4,
      lastDeliveryStatus: "delivered",
      lastDeliveryError: "typed delivery error",
      lastDelivered: true,
      lastFailureAlertAtMs: job.createdAtMs + 40_000,
      lastDiagnostics: { entries: [], summary: "kept" },
    };
    await saveCronStore(storeKey, store);

    const { stateDatabase, db } = openCronStoreTestDb();
    executeSqliteQuerySync(
      stateDatabase.db,
      db
        .updateTable("cron_jobs")
        .set({
          state_json: JSON.stringify({
            consecutiveErrors: 99,
            lastDelivered: false,
            lastDiagnostics: { entries: [], summary: "kept" },
            lastRunStatus: "error",
            nextRunAtMs: 1,
          }),
        })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", "job-state-typed"),
    );

    const loaded = await loadCronStore(storeKey);

    expect(loaded.jobs[0]?.state).toMatchObject({
      consecutiveErrors: 2,
      consecutiveSkipped: 3,
      lastDelivered: true,
      lastDeliveryError: "typed delivery error",
      lastDeliveryStatus: "delivered",
      lastDurationMs: 123,
      lastDiagnostics: { entries: [], summary: "kept" },
      lastError: "typed error",
      lastFailureAlertAtMs: job.createdAtMs + 40_000,
      lastRunAtMs: job.createdAtMs + 10_000,
      lastRunStatus: "ok",
      nextRunAtMs: job.createdAtMs + 60_000,
      runningAtMs: job.createdAtMs + 30_000,
      scheduleErrorCount: 4,
    });
  });

  it("loads SQLite state synchronously for task reconciliation", async () => {
    const { storeKey } = makeStoreKey();
    await saveCronStore(storeKey, makeStore("job-sync", true));

    const loaded = loadCronStoreSync(storeKey);

    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]?.id).toBe("job-sync");
    expect(loaded.jobs[0]?.state).toStrictEqual({});
    expect(loaded.jobs[0]?.updatedAtMs).toBeTypeOf("number");
  });

  it("stateOnly saves runtime state without replacing job definitions", async () => {
    const { storeKey } = makeStoreKey();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", false);
    second.jobs[0].state = {
      nextRunAtMs: second.jobs[0].createdAtMs + 60_000,
    };

    await saveCronStore(storeKey, first);
    await saveCronStore(storeKey, second, { stateOnly: true });

    const loaded = await loadCronStore(storeKey);
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-1"]);
    expect(loaded.jobs[0]?.state).toEqual({});
  });

  it("updates matching cron rows without rewriting the whole store", async () => {
    const { storeKey } = makeStoreKey();
    const first = makeStore("job-1", true);
    const second = makeStore("job-2", true);
    second.jobs[0].delivery = { channel: "telegram", to: "@old" } as never;
    first.jobs.push(second.jobs[0]);
    await saveCronStore(storeKey, first);

    const result = await updateCronStoreJobs(storeKey, (job) => {
      if (job.id !== "job-2") {
        return undefined;
      }
      return {
        ...job,
        delivery: { channel: "telegram", to: "-100123" } as never,
      };
    });

    const loaded = await loadCronStore(storeKey);
    expect(result).toEqual({ updatedJobs: 1 });
    expect(loaded.jobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(loaded.jobs[0]).toMatchObject({ id: "job-1" });
    expect("delivery" in (loaded.jobs[0] ?? {})).toBe(false);
    expect(loaded.jobs[1]).toMatchObject({
      id: "job-2",
      delivery: { channel: "telegram", to: "-100123" },
    });
  });
});
