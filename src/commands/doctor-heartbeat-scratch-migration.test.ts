import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCronJobScratchForMaintenance } from "../../test/helpers/cron/scratch-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.js";
import { readCronJobScratchState } from "../cron/scratch-store.js";
import {
  loadCronJobsStore,
  resolveCronJobsStorePath,
  resolveCronJobsStorePathFromConfig,
  saveCronJobsStore,
} from "../cron/store.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import {
  maybeMigrateHeartbeatCadenceToCron,
  retireHeartbeatWithDoctor,
} from "./doctor-heartbeat-retirement.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";
import { assertHeartbeatScratchMigrationUnambiguous } from "./doctor-heartbeat-scratch-preflight.js";
import { maybeMigrateHeartbeatTasksToCron } from "./doctor-heartbeat-task-migration.js";

const tempDirs: string[] = [];
let savedEnv: ReturnType<typeof captureEnv>;

beforeEach(() => {
  savedEnv = captureEnv(["HOME", "OPENCLAW_STATE_DIR"]);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  savedEnv.restore();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture(content?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-migration-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const cfg = {
    agents: {
      defaults: { heartbeat: { every: "30m" } },
      entries: { main: { workspace } },
    },
  } as OpenClawConfig;
  const heartbeatPath = path.join(workspace, "HEARTBEAT.md");
  if (content !== undefined) {
    await fs.writeFile(heartbeatPath, content);
  }
  return { root, stateDir, workspace, cfg, heartbeatPath };
}

function migrate(cfg: OpenClawConfig, shouldRepair = true) {
  return maybeMigrateHeartbeatFilesToScratch({ cfg, shouldRepair });
}

function receipt(storePath: string, agentId = "main") {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
    readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId),
  );
}

function expectFile(file: string, content: string) {
  return expect(fs.readFile(file, "utf8")).resolves.toBe(content);
}

async function loadMonitor(cfg?: OpenClawConfig) {
  const storePath = cfg ? resolveCronJobsStorePathFromConfig(cfg) : resolveCronJobsStorePath();
  const store = await loadCronJobsStore(storePath);
  const monitor = store.jobs.find(
    (job) => job.agentId === "main" && job.payload.kind === "agentTurn",
  );
  if (!monitor) {
    throw new Error("expected migrated heartbeat monitor");
  }
  return { monitor, storePath };
}

function sharedHeartbeatConfig(workspace: string, ollamaEvery = "0m") {
  return {
    agents: {
      defaults: { workspace },
      entries: {
        main: { workspace, heartbeat: { every: "30m" } },
        ollama: { workspace, heartbeat: { every: ollamaEvery } },
      },
    },
  } as OpenClawConfig;
}

describe("HEARTBEAT.md cron scratch migration", () => {
  it.each(["file", "imported scratch"])(
    "retires a checklist with an entry-less tasks: marker from %s",
    async (source) => {
      const content = "# Checklist\n\ntasks:\n- check the queue\n- review alerts\n";
      const fixture = await createFixture(content);
      if (source === "imported scratch") {
        await migrate(fixture.cfg);
      }

      const retired = await retireHeartbeatWithDoctor(fixture.cfg);

      expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
      const { monitor, storePath } = await loadMonitor();
      expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(content);
      expect(receipt(storePath)).toMatchObject({ jobId: monitor.id, phase: "complete" });
      await expect(fs.lstat(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
      const jobs = (await loadCronJobsStore(storePath)).jobs;
      expect(jobs).toHaveLength(1);
      await retireHeartbeatWithDoctor(retired);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(jobs);
    },
  );

  it("retains an incomplete task source before importing or archiving it", async () => {
    const content = "tasks:\n- name: inbox\n  interval: 1h\n";
    const fixture = await createFixture(content);

    await expect(retireHeartbeatWithDoctor(fixture.cfg)).rejects.toThrow(
      "no complete name/interval/prompt entries",
    );

    await expectFile(fixture.heartbeatPath, content);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch).toBeUndefined();
  });

  it.each(["0m", "15m"])(
    "finishes the Doctor pass with disabled defaults and an explicit %s sibling",
    async (every) => {
      const fixture = await createFixture("# HEARTBEAT.md\n# Proactive checks\n");
      fixture.cfg.agents!.defaults!.systemAgent = { agentId: "main" };
      fixture.cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        target: "discord",
        to: "channel:synthetic",
        directPolicy: "block",
      };
      fixture.cfg.agents!.entries!.other = {
        workspace: path.join(fixture.root, "other"),
        heartbeat: { every },
      };
      const retired = await retireHeartbeatWithDoctor(fixture.cfg);
      await maybeMigrateHeartbeatCadenceToCron({ cfg: retired, shouldRepair: true });
      await migrate(retired);
      const storePath = resolveCronJobsStorePathFromConfig(retired);
      const store = await loadCronJobsStore(storePath);
      expect(store.jobs.find((job) => job.agentId === "main")?.enabled).toBe(false);
      expect(store.jobs).toHaveLength(2);
      expect(store.jobs.find((job) => job.agentId === "other")?.enabled).toBe(every !== "0m");
      for (const agentId of ["main", "other"]) {
        expect(receipt(storePath, agentId)).toMatchObject({ phase: "complete" });
      }
      await retireHeartbeatWithDoctor(retired);
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(store.jobs);
    },
  );

  it.each(["admission", "repair"])(
    "preserves differing legacy scratch and its source during %s",
    async (phase) => {
      const source = "# Original instructions\r\nKeep the deployment healthy.\r\n";
      const fixture = await createFixture(source);
      const runtimeScratch = "Runtime notes from the last heartbeat\n";
      const storePath = resolveCronJobsStorePathFromConfig(fixture.cfg);
      const monitors = await ensureHeartbeatMonitorJobs(fixture.cfg, storePath);
      const monitor = monitors.get("main")!;
      writeCronJobScratchForMaintenance({
        storePath,
        jobId: monitor.id,
        content: runtimeScratch,
        expectedRevision: 0,
      });
      const originalScratch = readCronJobScratchState(storePath, monitor.id);
      expect(originalScratch.scratch?.sourceSha256).toBeUndefined();

      if (phase === "admission") {
        await expect(
          assertHeartbeatScratchMigrationUnambiguous(fixture.cfg, process.env),
        ).resolves.toBeUndefined();
      } else {
        const next = await retireHeartbeatWithDoctor(fixture.cfg);
        expect(next.agents?.defaults?.heartbeat).toBeUndefined();
        expect(receipt(storePath)).toMatchObject({ jobId: monitor.id, phase: "complete" });
        await expect(retireHeartbeatWithDoctor(next)).resolves.toEqual(next);
      }

      expect(readCronJobScratchState(storePath, monitor.id)).toEqual(originalScratch);
      await expectFile(fixture.heartbeatPath, source);
    },
  );

  it("previews without mutation, then migrates, archives, and reruns idempotently", async () => {
    const content = `# Operations\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n`;
    const fixture = await createFixture(content);

    const findings = await collectHeartbeatScratchMigrationFindings(fixture.cfg);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-scratch-migration",
        requirement: "legacy-heartbeat-file",
        target: "main",
      }),
    ]);
    await migrate(fixture.cfg, false);
    await expectFile(fixture.heartbeatPath, content);

    const migrated = await migrate(fixture.cfg);
    expect(migrated.warnings).toEqual([]);
    expect(migrated.changes).toHaveLength(1);
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });

    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch).toEqual(
      expect.objectContaining({ content, revision: 1, sourceSha256: expect.any(String) }),
    );
    const archiveDir = path.join(fixture.stateDir, "backups", "heartbeat-migration");
    const archives = await fs.readdir(archiveDir, { withFileTypes: true });
    const snapshot = archives.find((entry) => entry.isFile())!;
    const original = archives.find((entry) => entry.isDirectory())!;
    await expectFile(path.join(archiveDir, snapshot.name), content);
    await expectFile(path.join(archiveDir, original.name, "HEARTBEAT.md"), content);

    const rerun = await migrate(fixture.cfg);
    expect(rerun).toEqual({ changes: [], warnings: [] });
  });

  it.each([
    { completedId: "main", deleted: false, separateWorkspace: false },
    { completedId: "ollama", deleted: false, separateWorkspace: false },
    { completedId: "main", deleted: true, separateWorkspace: false },
    { completedId: "ollama", deleted: true, separateWorkspace: false },
    { completedId: "main", deleted: false, separateWorkspace: true },
  ])(
    "retains source for completed $completedId (job deleted: $deleted, separate workspace: $separateWorkspace)",
    async ({ completedId, deleted, separateWorkspace }) => {
      const fixture = await createFixture();
      const cfg = await retireHeartbeatWithDoctor({
        agents: {
          ownership: "explicit",
          entries: {
            [completedId]: { workspace: fixture.workspace, heartbeat: { every: "30m" } },
          },
        },
      });
      const storePath = resolveCronJobsStorePathFromConfig(cfg);
      const completedJob = (await loadCronJobsStore(storePath)).jobs[0]!;
      writeCronJobScratchForMaintenance({
        storePath,
        jobId: completedJob.id,
        content: "Completed owner's operator scratch\r\n",
        expectedRevision: 0,
      });
      if (deleted) {
        await saveCronJobsStore(storePath, { version: 1, jobs: [] });
      }
      const completedJobs = (await loadCronJobsStore(storePath)).jobs;
      const completedScratch = readCronJobScratchState(storePath, completedJob.id);
      const completedReceipt = receipt(storePath, completedId);
      expect(completedReceipt).toMatchObject({ jobId: completedJob.id, phase: "complete" });
      const pendingId = completedId === "main" ? "ollama" : "main";
      const pendingWorkspace = separateWorkspace
        ? path.join(fixture.root, "pending-workspace")
        : fixture.workspace;
      await fs.mkdir(pendingWorkspace, { recursive: true });
      cfg.agents!.entries![pendingId] = { workspace: pendingWorkspace };
      const content = "# Operator-restored checklist\r\n\r\nKeep these exact bytes.  \r\n";
      await fs.writeFile(fixture.heartbeatPath, content);

      await expect(migrate(cfg)).resolves.toEqual({ changes: [], warnings: [] });
      await expect(
        assertHeartbeatScratchMigrationUnambiguous(cfg, process.env),
      ).resolves.toBeUndefined();
      cfg.agents!.entries![pendingId] = {
        workspace: pendingWorkspace,
        heartbeat: { every: "30m" },
      };
      if (separateWorkspace) {
        await fs.writeFile(path.join(pendingWorkspace, "HEARTBEAT.md"), content);
      }
      const originalConfig = structuredClone(cfg);
      await expect(
        assertHeartbeatScratchMigrationUnambiguous(cfg, process.env),
      ).resolves.toBeUndefined();
      expect((await loadCronJobsStore(storePath)).jobs).toEqual(completedJobs);
      expect(receipt(storePath, pendingId)).toBeUndefined();

      const next = await retireHeartbeatWithDoctor(cfg);
      await expect(retireHeartbeatWithDoctor(next)).resolves.toEqual(next);

      await expectFile(fixture.heartbeatPath, content);
      expect(cfg).toEqual(originalConfig);
      expect(
        (await loadCronJobsStore(storePath)).jobs.filter((job) => job.agentId === completedId),
      ).toEqual(completedJobs);
      expect(readCronJobScratchState(storePath, completedJob.id)).toEqual(completedScratch);
      expect(receipt(storePath, completedId)).toEqual(completedReceipt);
      expect(receipt(storePath, pendingId)).toMatchObject({ phase: "complete" });
      const pendingJob = (await loadCronJobsStore(storePath)).jobs.find(
        (job) => job.agentId === pendingId,
      )!;
      expect(readCronJobScratchState(storePath, pendingJob.id).scratch?.content).toBe(content);
    },
  );

  it("imports shared scratch and tasks into disabled owners without re-enabling them", async () => {
    const source =
      "# Checklist\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n";
    const fixture = await createFixture(source);
    const cfg = sharedHeartbeatConfig(fixture.workspace);
    expect(await collectHeartbeatScratchMigrationFindings(cfg)).toHaveLength(2);
    const result = await migrate(cfg);
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    const storePath = resolveCronJobsStorePathFromConfig(cfg);
    const monitors = (await loadCronJobsStore(storePath)).jobs;
    for (const monitor of monitors) {
      expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(source);
    }
    await maybeMigrateHeartbeatTasksToCron({ cfg, shouldRepair: true });
    const disabled = (await loadCronJobsStore(storePath)).jobs.filter(
      (job) => job.agentId === "ollama",
    );
    expect(disabled).toHaveLength(2);
    expect(disabled.every((job) => !job.enabled)).toBe(true);
    expect(await migrate(cfg)).toEqual({
      changes: [],
      warnings: [],
    });
  });

  it.each(["before restore", "after restore"])(
    "preserves pending bytes and CAS after an inode edit %s",
    async (timing) => {
      const fixture = await createFixture("planned content\n");
      const cfg = sharedHeartbeatConfig(fixture.workspace);
      const monitors = await ensureHeartbeatMonitorJobs(
        cfg,
        resolveCronJobsStorePathFromConfig(cfg),
      );
      writeCronJobScratchForMaintenance({
        storePath: resolveCronJobsStorePathFromConfig(cfg),
        jobId: monitors.get("ollama")!.id,
        content: "Operator-owned checklist",
        expectedRevision: 0,
      });
      const sourceHandle = await fs.open(fixture.heartbeatPath, "r+");
      const link = fs.link.bind(fs);
      const edited = `${timing} descriptor edit\n`;
      vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
        if (timing === "after restore") {
          await link(from, to);
        }
        await sourceHandle.truncate(0);
        await sourceHandle.writeFile(edited, "utf8");
        await sourceHandle.sync();
        if (timing === "before restore") {
          await link(from, to);
        }
      });

      let result;
      try {
        result = await migrate(cfg);
      } finally {
        await sourceHandle.close();
      }

      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toContain(
        "changed after the migration claim was restored",
      );
      await expectFile(fixture.heartbeatPath, edited);
      const { monitor, storePath } = await loadMonitor(cfg);
      const pending = readCronJobScratchState(storePath, monitor.id);
      expect(pending).toMatchObject({
        currentRevision: 1,
        scratch: { content: "planned content\n", sourceSha256: expect.any(String) },
      });
      expect(
        writeCronJobScratchForMaintenance({
          storePath,
          jobId: monitor.id,
          content: "stale writer",
          expectedRevision: 0,
        }),
      ).toMatchObject({ ok: false, reason: "revision-conflict" });
      await migrate(cfg);
      const retried = readCronJobScratchState(storePath, monitor.id);
      expect(retried.currentRevision).toBe(2);
      expect(retried.scratch?.content).toBe(await fs.readFile(fixture.heartbeatPath, "utf8"));
      expect(readCronJobScratchState(storePath, monitors.get("ollama")!.id).scratch?.content).toBe(
        "Operator-owned checklist",
      );
    },
  );

  it("does not resurrect a legacy file after scratch was explicitly unset", async () => {
    const fixture = await createFixture("initial\n");
    await migrate(fixture.cfg);
    const { monitor, storePath } = await loadMonitor();
    const state = readCronJobScratchState(storePath, monitor.id);
    const unset = writeCronJobScratchForMaintenance({
      storePath,
      jobId: monitor.id,
      content: null,
      expectedRevision: state.currentRevision,
    });
    expect(unset.ok).toBe(true);
    await fs.writeFile(fixture.heartbeatPath, "recreated\n", "utf8");

    const result = await migrate(fixture.cfg);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notices?.join("\n")).toContain("scratch was explicitly unset");
    await expectFile(fixture.heartbeatPath, "recreated\n");
    expect(readCronJobScratchState(storePath, monitor.id).scratch).toBeUndefined();
  });

  it("preserves a concurrent file replacement acquired by the atomic claim", async () => {
    const fixture = await createFixture("planned content\n");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await fs.writeFile(String(from), "concurrent replacement\n", "utf8");
      await rename(from, to);
    });

    const result = await migrate(fixture.cfg);

    expect(result.warnings.join("\n")).toContain("changed before the migration claim");
    await expectFile(fixture.heartbeatPath, "concurrent replacement\n");
    // Nothing may be committed for a failed claim: scratch would otherwise
    // shadow the restored replacement file on the next heartbeat.
    expect(result.changes).toEqual([]);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id)).toEqual({ currentRevision: 0 });
  });

  it("never clobbers a recreated file when restoring a failed claim", async () => {
    const fixture = await createFixture("claimed original\n");
    const realpath = fs.realpath.bind(fs);
    // Fail the claim after the rename, and recreate the destination before the
    // restore runs — the classic editor atomic-save race.
    vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
      if (String(target).includes(".doctor-importing-")) {
        await fs.writeFile(fixture.heartbeatPath, "editor rewrite\n", "utf8");
        throw new Error("simulated claim verification failure");
      }
      return await realpath(target);
    });

    const result = await migrate(fixture.cfg);

    expect(result.changes).toEqual([]);
    await expectFile(fixture.heartbeatPath, "editor rewrite\n");
    const workspaceEntries = await fs.readdir(fixture.workspace);
    const conflict = workspaceEntries.find((entry) => entry.includes(".conflict-"));
    expect(conflict, workspaceEntries.join(",")).toBeDefined();
    await expectFile(path.join(fixture.workspace, conflict!), "claimed original\n");
  });

  it("recovers an interrupted migration claim on the next doctor --fix", async () => {
    const fixture = await createFixture();
    const content = "interrupted checklist\n";
    // Simulate a crash after the claim rename: only the claim file exists.
    // Use a provably dead PID so recovery does not treat it as an active run.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    await fs.writeFile(
      `${fixture.heartbeatPath}.doctor-importing-${deadPid}-deadbeefdead`,
      content,
      "utf8",
    );

    const findings = await collectHeartbeatScratchMigrationFindings(fixture.cfg);
    expect(findings).toEqual([
      expect.objectContaining({ requirement: "heartbeat-file-migration-blocked" }),
    ]);
    expect(findings[0]!.message).toContain("interrupted migration claim");

    const result = await migrate(fixture.cfg);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(content);
    const workspaceEntries = await fs.readdir(fixture.workspace);
    expect(workspaceEntries.filter((entry) => entry.includes(".doctor-importing-"))).toEqual([]);
  });

  it("refuses to steal a claim held by a live doctor process", async () => {
    const fixture = await createFixture();
    // This test's own PID is trivially alive and not ours-by-name.
    const claimPath = `${fixture.heartbeatPath}.doctor-importing-1-abcdefabcdef`;
    await fs.writeFile(claimPath, "in-flight migration\n", "utf8");

    const result = await migrate(fixture.cfg);

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("held by running process 1");
    await expectFile(claimPath, "in-flight migration\n");
  });

  it("migrates a contained symlinked HEARTBEAT.md and removes the link", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.workspace, "real-heartbeat.md");
    await fs.writeFile(targetPath, "linked checklist\n", "utf8");
    await fs.symlink("real-heartbeat.md", fixture.heartbeatPath);

    const result = await migrate(fixture.cfg);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(
      "linked checklist\n",
    );
    // The symlink is removed; the contained target file itself is untouched.
    await expect(fs.lstat(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectFile(targetPath, "linked checklist\n");
  });

  it("rejects external symlink targets without importing or removing them", async () => {
    const fixture = await createFixture();
    const external = path.join(fixture.root, "outside.md");
    await fs.writeFile(external, "outside\n", "utf8");
    await fs.symlink(external, fixture.heartbeatPath);

    const result = await migrate(fixture.cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("escapes the agent workspace");
    await expect(fs.lstat(fixture.heartbeatPath)).resolves.toMatchObject({});
  });
});
