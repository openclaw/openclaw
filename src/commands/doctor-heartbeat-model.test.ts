import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import { retireHeartbeatWithDoctor } from "./doctor-heartbeat-retirement.js";
import { retainHeartbeatMigrationInput } from "./doctor/shared/config-migration-result.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await testApi.flushFileLogQueueForTests();
    setLoggerOverride(null);
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

it.each([
  { allowed: false, pending: false },
  { allowed: false, pending: true },
  { allowed: true, pending: false },
])(
  "migrates heartbeat model authority (allowed=$allowed, pending=$pending)",
  async ({ allowed, pending }) => {
    const root = tempDirs.make("openclaw-heartbeat-model-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("HOME", path.join(root, "home"));
    const logFile = path.join(root, "doctor.log");
    setLoggerOverride({ level: "warn", consoleLevel: "silent", file: logFile });
    const note = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
    const defaultModel = `openai/gpt-5.4${pending ? "@openai:subscription" : ""}`;
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: defaultModel,
          modelPolicy: { allow: ["openai/gpt-5.4"] },
          heartbeat: { agentId: "main", model: "openai/gpt-4o-mini", every: "30m" },
        },
        entries: {
          main: {
            workspace: path.join(root, "workspace"),
            ...(allowed
              ? { modelPolicy: { allow: ["openai/gpt-5.4", "openai/gpt-4o-mini"] } }
              : {}),
          },
        },
      },
    };
    const original = structuredClone(cfg);
    const storePath = resolveCronJobsStorePathFromConfig(cfg);
    const storeKey = cronStoreKey(storePath);
    runOpenClawStateWriteTransaction(({ db }) => {
      for (const [index, id] of ["monitor", "row-only"].entries()) {
        const job: CronStoredJob = {
          id,
          agentId: "main",
          ...(index === 0 ? { declarationKey: "heartbeat:main" } : {}),
          name: id,
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 1_800_000, anchorMs: 0 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "Legacy monitor" },
          state: {},
        };
        upsertCronJobRow(db, storeKey, job, index);
        db.prepare(
          "UPDATE cron_jobs SET payload_kind = 'heartbeat', job_json = ? WHERE store_key = ? AND job_id = ?",
        ).run(JSON.stringify({ ...job, payload: { kind: "heartbeat" } }), storeKey, id);
      }
    });
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const next = await withPluginMetadataSnapshotScope(metadataSnapshot, async () => {
      if (pending) {
        await ensureHeartbeatMonitorJobs(cfg, storePath);
        expect(
          withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
            readDefaultProactiveJobReceiptInDatabase(db, storePath, "main"),
          ),
        ).toMatchObject({ phase: "pending", convertedJobIds: ["row-only"] });
        expect(note.mock.calls.filter(([, title]) => title === "Heartbeat model changed")).toEqual(
          [],
        );
      }
      return retireHeartbeatWithDoctor(cfg);
    });
    expect(cfg).toEqual(original);
    expect(next.agents?.defaults?.modelPolicy).toEqual(original.agents?.defaults?.modelPolicy);
    expect(next.agents?.entries?.main?.modelPolicy).toEqual(
      original.agents?.entries?.main?.modelPolicy,
    );
    const billing = await retainHeartbeatMigrationInput(next, cfg);
    expect(billing.agents?.defaults?.heartbeat?.agentId).toBe("main");
    expect(billing.agents?.entries?.main?.heartbeat).not.toHaveProperty("agentId");
    expect(billing.agents?.entries?.main?.heartbeat?.every).toBe("30m");
    expect(billing.agents?.entries?.main?.heartbeat?.model).toBe(
      allowed ? "openai/gpt-4o-mini" : defaultModel,
    );
    const jobs = withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => loadedCronStoreFromRows(loadCronRows(db, storeKey)).store.jobs,
    )!;
    expect(jobs.map((job) => job.id)).toEqual(["monitor", "row-only"]);
    for (const job of jobs) {
      expect(job.payload.kind).toBe("agentTurn");
      if (allowed) {
        expect(job.payload).toMatchObject({ model: "openai/gpt-4o-mini" });
      } else {
        expect(job.payload).not.toHaveProperty("model");
      }
    }
    const warnings = note.mock.calls.filter(([, title]) => title === "Heartbeat model changed");
    if (allowed) {
      expect(warnings).toEqual([]);
    } else {
      expect(warnings).toHaveLength(1);
      await testApi.flushFileLogQueueForTests();
      const logged = (await fs.readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message);
      for (const id of ["monitor", "row-only"]) {
        const message = `Agent "main" automation "${id}": dropped heartbeat model "openai/gpt-4o-mini"`;
        expect(warnings[0]?.[0]).toContain(message);
        expect(logged).toEqual(expect.arrayContaining([expect.stringContaining(message)]));
      }
      expect(warnings[0]?.[0]).toContain(`configured default "${defaultModel}"`);
      expect(warnings[0]?.[0]).toContain("agents.entries.main.modelPolicy.allow");
    }
    await expect(retireHeartbeatWithDoctor(billing)).resolves.toEqual(next);
    expect(note.mock.calls.filter(([, title]) => title === "Heartbeat model changed")).toEqual(
      warnings,
    );
  },
);
