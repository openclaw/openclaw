import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { writeCronJobScratchForMaintenance } from "../../test/helpers/cron/scratch-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  changedStoreFiles,
  snapshotStoreFiles,
} from "../test-utils/store-snapshot.test-support.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import {
  checkHeartbeatRetirementPending,
  maybeMigrateHeartbeatCadenceToCron,
} from "./doctor-heartbeat-retirement.js";
import {
  checkHeartbeatTaskMigrationPending,
  maybeMigrateHeartbeatTasksToCron,
} from "./doctor-heartbeat-task-migration.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function fixture() {
  const root = tempDirs.make("openclaw-heartbeat-pending-");
  const env = { ...process.env, HOME: path.join(root, "home"), OPENCLAW_STATE_DIR: root };
  vi.stubEnv("HOME", env.HOME);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.spyOn(terminalNote, "note").mockImplementation(() => {});
  const cfg = {
    agents: {
      ownership: "explicit",
      defaults: { heartbeat: { every: "30m" }, systemAgent: { agentId: "main" } },
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
  } as OpenClawConfig;
  return { root, env, cfg, storePath: resolveCronJobsStorePathFromConfig(cfg, env) };
}

it("has retirement work while heartbeat cadence is unmigrated, and none after the run", async () => {
  const f = fixture();
  const pending = (shouldRepair = true) =>
    checkHeartbeatRetirementPending({ cfg: f.cfg, env: f.env, shouldRepair });

  // Before any store exists the configured cadence is the work; the check creates nothing.
  await expect(pending()).resolves.toBe("work");
  await expect(pending(false)).resolves.toBe("none");
  expect(fs.readdirSync(f.root)).toEqual([]);

  openOpenClawStateDatabase({ env: f.env });
  const before = snapshotStoreFiles(f.root);
  await expect(pending()).resolves.toBe("work");
  expect(changedStoreFiles(before, snapshotStoreFiles(f.root))).toEqual([]);

  await expect(
    maybeMigrateHeartbeatCadenceToCron({ cfg: f.cfg, env: f.env, shouldRepair: true }),
  ).resolves.toMatchObject({ warnings: [] });
  await expect(pending()).resolves.toBe("none");
});

it("cannot decide while no connection holds the state database open", async () => {
  const f = fixture();
  openOpenClawStateDatabase({ env: f.env });
  closeOpenClawStateDatabaseForTest();
  const statePath = resolveOpenClawStateSqlitePath(f.env);
  const sidecars = () =>
    fs.readdirSync(path.dirname(statePath)).filter((name) => /-(wal|shm)$/u.test(name));
  expect(sidecars()).toEqual([]);

  await expect(
    checkHeartbeatRetirementPending({ cfg: f.cfg, env: f.env, shouldRepair: true }),
  ).resolves.toBe("undecidable");
  await expect(
    checkHeartbeatTaskMigrationPending({ cfg: f.cfg, env: f.env, shouldRepair: true }),
  ).resolves.toBe("undecidable");
  expect(sidecars()).toEqual([]);
});

it.each([
  {
    name: "a valid task block",
    tasks: "  - name: inbox\n    interval: 1h\n    prompt: Check mail\n",
  },
  { name: "an invalid task block", tasks: "  - name: inbox\n    interval: soon\n" },
])("has task migration work exactly when the run converts $name", async ({ name, tasks }) => {
  const f = fixture();
  const monitor = (await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env)).get("main")!;
  writeCronJobScratchForMaintenance({
    storePath: f.storePath,
    jobId: monitor.id,
    content: `# Operations\n\ntasks:\n${tasks}`,
    expectedRevision: 0,
    options: { env: f.env },
  });
  const pending = (shouldRepair = true) =>
    checkHeartbeatTaskMigrationPending({ cfg: f.cfg, env: f.env, shouldRepair });
  const valid = name === "a valid task block";

  const before = snapshotStoreFiles(f.root);
  await expect(pending()).resolves.toBe(valid ? "work" : "none");
  await expect(pending(false)).resolves.toBe("none");
  expect(changedStoreFiles(before, snapshotStoreFiles(f.root))).toEqual([]);

  const result = await maybeMigrateHeartbeatTasksToCron({
    cfg: f.cfg,
    env: f.env,
    shouldRepair: true,
  });
  // The invalid block is refused with a warning and left in place.
  expect(result.changes).toHaveLength(valid ? 1 : 0);
  expect(result.warnings).toHaveLength(valid ? 0 : 1);
  await expect(pending()).resolves.toBe("none");
});
