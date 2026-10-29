import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withStateMigrationBackupForTest } from "../state/openclaw-state-schema.test-support.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { readCronScratchSnapshot } from "./scratch-read.js";
import {
  loadCronStore,
  loadCronJobsStore,
  loadCronQuarantinedJobs,
  resolveCronStorePathAsync,
  saveCronStore,
  saveCronQuarantinedJobs,
} from "./store.js";
import { createReloadCronJob } from "./store.test-support.js";
import { writeCronJobScratch } from "./store.worker.test-support.js";
import {
  claimCronRunReceiptInDatabase,
  finishCronRunReceiptInDatabase,
} from "./store/run-receipt-store.js";
import { prepareCronRunReceiptWriteSchema } from "./store/run-receipt-write-admission.js";
import type { CronRunReceiptHandle } from "./store/run-receipt.types.js";
import { createCronScheduledRunId } from "./store/run-request-id.js";

function storedPartition(jobId: string): string {
  const row = expectDefined(
    openOpenClawStateDatabase()
      .db.prepare("SELECT store_key FROM cron_jobs WHERE job_id = ?")
      .get(jobId),
    "persisted cron job",
  );
  expect(row.store_key).toBeTypeOf("string");
  return String(row.store_key);
}

function claimReceipt(handle: CronRunReceiptHandle) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({ database: db, handle, requestRunId: "request-unchanged" }),
  );
}

function finishReceipt(handle: CronRunReceiptHandle) {
  return runOpenClawStateWriteTransaction(({ db }) =>
    finishCronRunReceiptInDatabase({
      database: db,
      receiptSchema: prepareCronRunReceiptWriteSchema(db),
      handle,
      pendingReceiptId: undefined,
      status: "ok",
      finishedAtMs: handle.startedAtMs + 1,
    }),
  );
}

it("follows changes to the configured partition when SDK loads omit the path", async () => {
  await withOpenClawTestState({ label: "cron-implicit-selection" }, async (state) => {
    try {
      const first = state.statePath("first.json");
      const second = state.statePath("second.json");
      await saveCronStore(first, { version: 1, jobs: [createReloadCronJob({ id: "first" })] });
      await saveCronStore(second, { version: 1, jobs: [createReloadCronJob({ id: "second" })] });
      writeConfigMachineState("cron.store", first);
      expect((await loadCronJobsStore()).jobs.map((job) => job.id)).toEqual(["first"]);
      writeConfigMachineState("cron.store", second);
      expect((await loadCronJobsStore()).jobs.map((job) => job.id)).toEqual(["second"]);
    } finally {
      await closeStateDatabaseForTest();
    }
  });
});

it("keeps an external config directory in public SDK default selection", async () => {
  await withOpenClawTestState(
    {
      label: "cron-external-config",
      layout: "split",
      env: { OPENCLAW_STATE_DIR: undefined, OPENCLAW_PROFILE: undefined },
    },
    async (state) => {
      try {
        const storePath = await resolveCronStorePathAsync();
        expect(storePath).toBe(path.join(path.dirname(state.configPath), "cron", "jobs.json"));
        const job = createReloadCronJob({ id: "external-config-job" });
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        expect(storedPartition(job.id)).toBe(storePath);
        writeConfigMachineState("cron.store", storePath);
        expect((await loadCronJobsStore()).jobs).toEqual([job]);
        await expect(
          writeCronJobScratch({ storePath, jobId: job.id, content: "Retained scratch" }),
        ).resolves.toMatchObject({ ok: true });
        expect(
          await readCronScratchSnapshot(storePath, {
            kind: "job",
            jobId: job.id,
            createdAtMsFallback: job.createdAtMs,
          }),
        ).toMatchObject({ state: { scratch: { content: "Retained scratch" } } });
        const entry = { sourceIndex: 0, reason: "Malformed job", raw: { id: "bad" } };
        await saveCronQuarantinedJobs({ storePath, entries: [entry], nowMs: 100 });
        expect(await loadCronQuarantinedJobs(storePath)).toMatchObject([entry]);
      } finally {
        await closeStateDatabaseForTest();
      }
    },
  );
});

it("preserves an external default partition during a worker-led v32 upgrade", async () => {
  await withOpenClawTestState(
    {
      label: "cron-external-upgrade",
      layout: "split",
      env: { OPENCLAW_STATE_DIR: undefined, OPENCLAW_PROFILE: undefined },
    },
    async (state) => {
      try {
        const storePath = await resolveCronStorePathAsync();
        const job = createReloadCronJob({ id: "external-upgrade-job" });
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        const databasePath = openOpenClawStateDatabase().path;
        await closeStateDatabaseForTest();
        {
          using legacy = new DatabaseSync(databasePath);
          // Main saved the explicit external path before the binding existed.
          legacy.prepare("UPDATE cron_jobs SET store_key = ?").run(storePath);
          legacy.exec(`DELETE FROM config_machine_state WHERE state_key IN
            ('cron.defaultStoreKey', 'state.schema.contentVersion');
            UPDATE schema_meta SET schema_version = 32;
            PRAGMA user_version = 32;`);
        }
        const copy = `${databasePath}.predecessor`;
        await fs.copyFile(databasePath, copy);
        await fs.rename(copy, databasePath);
        await withStateMigrationBackupForTest({ env: state.envVars }, async () => {
          expect((await loadCronJobsStore()).jobs).toEqual([job]);
        });
        expect(storedPartition(job.id)).toBe(storePath);
        const binding = openOpenClawStateDatabase()
          .db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("cron.defaultStoreKey");
        expect(binding?.value_json).toBe(JSON.stringify(storePath));
      } finally {
        await closeStateDatabaseForTest();
      }
    },
  );
});

it("keeps SDK jobs, scratch and scheduled dedupe reachable after a stopped state-directory move", async () => {
  await withOpenClawTestState({ label: "cron-stopped-move" }, async (state) => {
    try {
      const sourcePath = await resolveCronStorePathAsync();
      const job = createReloadCronJob({ id: "relocated-job", name: "Retained job" });
      await saveCronStore(sourcePath, { version: 1, jobs: [job] });
      expect(
        await writeCronJobScratch({
          storePath: sourcePath,
          jobId: job.id,
          content: "- [ ] retained scratch",
          expectedRevision: 0,
          nowMs: 100,
        }),
      ).toMatchObject({ ok: true, currentRevision: 1 });
      const sourceKey = storedPartition(job.id);
      const receipt: CronRunReceiptHandle = {
        storeKey: sourceKey,
        receiptId: createCronScheduledRunId(sourceKey, job.id, 1_000),
        jobId: job.id,
        configRevision: resolveCronJobConfigRevision(job),
        agentId: "main",
        ownerPid: process.pid,
        ownerStartTime: null,
        startedAtMs: 1_000,
      };
      expect(claimReceipt(receipt)).toEqual(receipt);
      expect(finishReceipt(receipt)).toBe(true);

      await closeStateDatabaseForTest();
      const movedDir = state.path("moved-state");
      await fs.rename(state.stateDir, movedDir);
      state.envVars.OPENCLAW_STATE_DIR = movedDir;
      state.envVars.OPENCLAW_CONFIG_PATH = path.join(movedDir, "openclaw.json");
      state.applyEnv();
      const movedPath = await resolveCronStorePathAsync();
      expect(movedPath).toBe(path.join(movedDir, "cron", "jobs.json"));
      expect(movedPath).not.toBe(sourcePath);
      await expect(fs.stat(state.stateDir)).rejects.toMatchObject({ code: "ENOENT" });

      expect(await loadCronStore(movedPath)).toEqual({ version: 1, jobs: [job] });
      expect(storedPartition(job.id)).toBe(sourceKey);
      expect(
        await readCronScratchSnapshot(movedPath, {
          kind: "job",
          jobId: job.id,
          createdAtMsFallback: job.createdAtMs,
        }),
      ).toMatchObject({
        jobId: job.id,
        state: {
          currentRevision: 1,
          scratch: { content: "- [ ] retained scratch", revision: 1, updatedAtMs: 100 },
        },
      });
      // Replaying a completed scheduled occurrence still loses the durable claim.
      expect(claimReceipt(receipt)).toBeUndefined();
      const next = {
        ...receipt,
        receiptId: createCronScheduledRunId(storedPartition(job.id), job.id, 2_000),
        startedAtMs: 2_000,
      };
      expect(claimReceipt(next)).toEqual(next);
      expect(finishReceipt(next)).toBe(true);
      expect(
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT receipt_id, request_run_id FROM cron_run_receipts ORDER BY started_at_ms",
          )
          .all(),
      ).toEqual([
        { receipt_id: receipt.receiptId, request_run_id: "request-unchanged" },
        { receipt_id: next.receiptId, request_run_id: "request-unchanged" },
      ]);

      job.name = "Saved through relocated SDK path";
      await saveCronStore(movedPath, { version: 1, jobs: [job] });
      expect((await loadCronStore(movedPath)).jobs[0]?.name).toBe(job.name);
      expect(storedPartition(job.id)).toBe(sourceKey);
    } finally {
      await closeStateDatabaseForTest();
    }
  });
});

it.each(["scratch", "scratch-read", "quarantine"] as const)(
  "admits a v32 store before its first SDK %s operation selects the default partition",
  async (operation) => {
    await withOpenClawTestState({ label: `cron-v32-${operation}` }, async (state) => {
      try {
        const storePath = await resolveCronStorePathAsync();
        const job = createReloadCronJob({ id: "upgrade-job", name: "Upgrade job" });
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        const databasePath = openOpenClawStateDatabase().path;
        await closeStateDatabaseForTest();
        {
          using legacy = new DatabaseSync(databasePath);
          // v32 has the same catalog; restore its path identity and version markers.
          legacy.prepare("UPDATE cron_jobs SET store_key = ?").run(storePath);
          legacy.exec(`DELETE FROM config_machine_state WHERE state_key IN
            ('cron.defaultStoreKey', 'state.schema.contentVersion');
            UPDATE schema_meta SET schema_version = 32;
            PRAGMA user_version = 32;`);
        }
        const copy = `${databasePath}.predecessor`;
        await fs.copyFile(databasePath, copy);
        await fs.rename(copy, databasePath);
        const entry = { sourceIndex: 0, reason: "Retained malformed job", raw: { id: "bad" } };
        await withStateMigrationBackupForTest({ env: state.envVars }, async () => {
          if (operation === "scratch") {
            await expect(
              writeCronJobScratch({ storePath, jobId: job.id, content: "Retained scratch" }),
            ).resolves.toMatchObject({ ok: true, currentRevision: 1 });
          } else if (operation === "scratch-read") {
            await expect(
              readCronScratchSnapshot(storePath, {
                kind: "job",
                jobId: job.id,
                createdAtMsFallback: job.createdAtMs,
              }),
            ).resolves.toMatchObject({ jobId: job.id, state: { currentRevision: 0 } });
          } else {
            await saveCronQuarantinedJobs({ storePath, entries: [entry], nowMs: 100 });
          }
        });
        expect(storedPartition(job.id)).toBe(storePath);
        if (operation === "scratch") {
          expect(
            await readCronScratchSnapshot(storePath, {
              kind: "job",
              jobId: job.id,
              createdAtMsFallback: job.createdAtMs,
            }),
          ).toMatchObject({
            state: { scratch: { content: "Retained scratch" } },
          });
        } else if (operation === "quarantine") {
          expect(await loadCronQuarantinedJobs(storePath)).toMatchObject([entry]);
        }
      } finally {
        await closeStateDatabaseForTest();
      }
    });
  },
);

it("keeps a literal custom default path separate from the logical default partition", async () => {
  await withOpenClawTestState({ label: "cron-sdk-default-path" }, async () => {
    try {
      const defaultPath = await resolveCronStorePathAsync();
      const customPath = await resolveCronStorePathAsync("default");
      expect(customPath).toBe(path.resolve("default"));
      const standard = createReloadCronJob({ id: "standard", name: "Standard" });
      const custom = createReloadCronJob({ id: "custom", name: "Custom" });
      await saveCronStore(defaultPath, { version: 1, jobs: [standard] });
      await saveCronStore("default", { version: 1, jobs: [custom] });

      expect((await loadCronStore(defaultPath)).jobs.map((job) => job.id)).toEqual(["standard"]);
      expect((await loadCronStore(customPath)).jobs.map((job) => job.id)).toEqual(["custom"]);
      expect(storedPartition("standard")).toBe(defaultPath);
      expect(storedPartition("custom")).toBe(customPath);
    } finally {
      await closeStateDatabaseForTest();
    }
  });
});
