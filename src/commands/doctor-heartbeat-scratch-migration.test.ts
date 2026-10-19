import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readCronJobScratchState } from "../cron/scratch-store.js";
import { writeCronJobScratchForMaintenance } from "../cron/scratch-write.kernel.js";
import {
  loadCronJobsStore,
  resolveCronJobsStorePath,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import { useHeartbeatMigrationRoots } from "./doctor-heartbeat-migration.test-support.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";
import { maybeMigrateHeartbeatTasksToCron } from "./doctor-heartbeat-task-migration.js";

const makeRoot = useHeartbeatMigrationRoots("openclaw-heartbeat-migration-");

async function createFixture() {
  const root = await makeRoot();
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const cfg = {
    agents: { defaults: { heartbeat: { every: "30m" } }, entries: { main: { workspace } } },
  } as OpenClawConfig;
  const heartbeatPath = path.join(workspace, "HEARTBEAT.md");
  return {
    scratch: async (config = cfg, agentId = "main") => {
      const { monitor, storePath } = await loadMonitor(config, agentId);
      return readCronJobScratchState(storePath, monitor.id);
    },
    root,
    stateDir,
    workspace,
    cfg,
    heartbeatPath,
    write: (content: string) => fs.writeFile(heartbeatPath, content, "utf8"),
    read: () => fs.readFile(heartbeatPath, "utf8"),
    migrate: (config = cfg, shouldRepair = true) =>
      maybeMigrateHeartbeatFilesToScratch({ cfg: config, shouldRepair }),
  };
}

async function loadMonitor(cfg?: OpenClawConfig, agentId = "main") {
  const storePath = cfg ? resolveCronJobsStorePathFromConfig(cfg) : resolveCronJobsStorePath();
  const store = await loadCronJobsStore(storePath);
  const monitor = store.jobs.find(
    (job) => job.agentId === agentId && job.payload.kind === "heartbeat",
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

it("previews without mutation, then migrates, archives, and reruns idempotently", async () => {
  const f = await createFixture();
  const content = `# Operations\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n`;
  await f.write(content);
  const findings = await collectHeartbeatScratchMigrationFindings(f.cfg);
  expect(findings).toEqual([
    expect.objectContaining({
      checkId: "core/doctor/heartbeat-scratch-migration",
      requirement: "legacy-heartbeat-file",
      target: "main",
    }),
  ]);
  await f.migrate(f.cfg, false);
  await expect(f.read()).resolves.toBe(content);
  const migrated = await f.migrate();
  expect(migrated.warnings).toEqual([]);
  expect(migrated.changes).toHaveLength(1);
  await expect(fs.access(f.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.scratch()).scratch).toEqual(
    expect.objectContaining({ content, revision: 1, sourceSha256: expect.any(String) }),
  );
  const archiveDir = path.join(f.stateDir, "backups", "heartbeat-migration");
  const archives = await fs.readdir(archiveDir, { withFileTypes: true });
  const snapshot = archives.find((entry) => entry.isFile())!;
  const original = archives.find((entry) => entry.isDirectory())!;
  await expect(fs.readFile(path.join(archiveDir, snapshot.name), "utf8")).resolves.toBe(content);
  await expect(
    fs.readFile(path.join(archiveDir, original.name, "HEARTBEAT.md"), "utf8"),
  ).resolves.toBe(content);
  expect(await f.migrate()).toEqual({ changes: [], warnings: [] });
});

it("copies into enabled scratch while retaining a file shared with a disabled agent", async () => {
  const f = await createFixture();
  const cfg = sharedHeartbeatConfig(f.workspace);
  await f.write("shared checklist\n");
  await expect(collectHeartbeatScratchMigrationFindings(cfg)).resolves.toEqual([]);
  const result = await f.migrate(cfg);
  expect(result.warnings).toEqual([]);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toContain("retained the shared legacy file");
  await expect(f.read()).resolves.toBe("shared checklist\n");
  expect((await f.scratch(cfg)).scratch?.content).toBe("shared checklist\n");
  const rename = vi.spyOn(fs, "rename");
  expect(await f.migrate(cfg)).toEqual({ changes: [], warnings: [] });
  expect(rename).not.toHaveBeenCalled();
  await expect(f.read()).resolves.toBe("shared checklist\n");
});

it("imports a retained task source after its disabled owner is re-enabled", async () => {
  const f = await createFixture();
  const source =
    "# Checklist\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n";
  const mixed = sharedHeartbeatConfig(f.workspace);
  await f.write(source);
  await f.migrate(mixed);
  await maybeMigrateHeartbeatTasksToCron({ cfg: mixed, shouldRepair: true });
  const enabled = sharedHeartbeatConfig(f.workspace, "30m");
  const result = await f.migrate(enabled);
  expect(result.warnings).toEqual([]);
  await expect(fs.access(f.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await f.scratch(enabled, "ollama")).scratch?.content).toBe(source);
});

it("imports a changed retained source into a re-enabled owner without overwriting its peer", async () => {
  const f = await createFixture();
  const mixed = sharedHeartbeatConfig(f.workspace);
  await f.write("original checklist\n");
  await f.migrate(mixed);
  await f.write("updated checklist\n");
  const enabled = sharedHeartbeatConfig(f.workspace, "30m");
  const result = await f.migrate(enabled);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toContain("another heartbeat owner's scratch was left unchanged");
  expect(result.changes[0]).not.toContain("disabled");
  expect(result.warnings.join("\n")).toContain("already has different cron scratch");
  await expect(f.read()).resolves.toBe("updated checklist\n");
  const storePath = resolveCronJobsStorePath();
  const store = await loadCronJobsStore(storePath);
  const scratchByAgentId = new Map(
    store.jobs
      .filter((job) => job.payload.kind === "heartbeat")
      .map((job) => [job.agentId, readCronJobScratchState(storePath, job.id).scratch?.content]),
  );
  expect(scratchByAgentId.get("main")).toBe("original checklist\n");
  expect(scratchByAgentId.get("ollama")).toBe("updated checklist\n");
});

it("rolls back retained scratch when the claimed inode changes during restoration", async () => {
  const f = await createFixture();
  const cfg = sharedHeartbeatConfig(f.workspace);
  await f.write("planned content\n");
  const sourceHandle = await fs.open(f.heartbeatPath, "r+");
  const link = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementationOnce(async (from, to) => {
    await link(from, to);
    await sourceHandle.truncate(0);
    await sourceHandle.writeFile("restore-window descriptor edit\n", "utf8");
    await sourceHandle.sync();
  });
  let result;
  try {
    result = await f.migrate(cfg);
  } finally {
    await sourceHandle.close();
  }
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain("changed after the migration claim was restored");
  await expect(f.read()).resolves.toBe("restore-window descriptor edit\n");
  expect(await f.scratch(cfg)).toEqual({ currentRevision: 0 });
});

it("does not resurrect a legacy file after scratch was explicitly unset", async () => {
  const f = await createFixture();
  await f.write("initial\n");
  await f.migrate();
  const { monitor, storePath } = await loadMonitor();
  const state = readCronJobScratchState(storePath, monitor.id);
  const unset = writeCronJobScratchForMaintenance({
    storePath,
    jobId: monitor.id,
    content: null,
    expectedRevision: state.currentRevision,
  });
  expect(unset.ok).toBe(true);
  await f.write("recreated\n");
  const result = await f.migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain("scratch was explicitly unset");
  await expect(f.read()).resolves.toBe("recreated\n");
  expect(readCronJobScratchState(storePath, monitor.id).scratch).toBeUndefined();
});

it("preserves a concurrent file replacement acquired by the atomic claim", async () => {
  const f = await createFixture();
  await f.write("planned content\n");
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    await fs.writeFile(String(from), "concurrent replacement\n", "utf8");
    await rename(from, to);
  });
  const result = await f.migrate();
  expect(result.warnings.join("\n")).toContain("changed before the migration claim");
  await expect(f.read()).resolves.toBe("concurrent replacement\n");
  expect(result.changes).toEqual([]);
  expect(await f.scratch()).toEqual({ currentRevision: 0 });
});

it("never clobbers a recreated file when restoring a failed claim", async () => {
  const f = await createFixture();
  await f.write("claimed original\n");
  const realpath = fs.realpath.bind(fs);
  // Fail the claim after the rename, and recreate the destination before the
  // restore runs — the classic editor atomic-save race.
  vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
    if (String(target).includes(".doctor-importing-")) {
      await f.write("editor rewrite\n");
      throw new Error("simulated claim verification failure");
    }
    return await realpath(target);
  });
  const result = await f.migrate();
  expect(result.changes).toEqual([]);
  await expect(f.read()).resolves.toBe("editor rewrite\n");
  const workspaceEntries = await fs.readdir(f.workspace);
  const conflict = workspaceEntries.find((entry) => entry.includes(".conflict-"));
  expect(conflict, workspaceEntries.join(",")).toBeDefined();
  await expect(fs.readFile(path.join(f.workspace, conflict!), "utf8")).resolves.toBe(
    "claimed original\n",
  );
});

it("recovers an interrupted migration claim on the next doctor --fix", async () => {
  const f = await createFixture();
  const content = "interrupted checklist\n";
  // Simulate a crash after the claim rename: only the claim file exists.
  // Use a provably dead PID so recovery does not treat it as an active run.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  await fs.writeFile(
    `${f.heartbeatPath}.doctor-importing-${deadPid}-deadbeefdead`,
    content,
    "utf8",
  );
  expect(await collectHeartbeatScratchMigrationFindings(f.cfg)).toEqual([
    expect.objectContaining({
      requirement: "heartbeat-file-migration-blocked",
      message: expect.stringContaining("interrupted migration claim"),
    }),
  ]);
  const result = await f.migrate();
  expect(result.warnings).toEqual([]);
  expect(result.changes).toHaveLength(1);
  expect((await f.scratch()).scratch?.content).toBe(content);
  const workspaceEntries = await fs.readdir(f.workspace);
  expect(workspaceEntries.filter((entry) => entry.includes(".doctor-importing-"))).toEqual([]);
});

it("refuses to steal a claim held by a live doctor process", async () => {
  const f = await createFixture();
  const claimPath = `${f.heartbeatPath}.doctor-importing-1-abcdefabcdef`;
  await fs.writeFile(claimPath, "in-flight migration\n", "utf8");
  const result = await f.migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain("held by running process 1");
  await expect(fs.readFile(claimPath, "utf8")).resolves.toBe("in-flight migration\n");
});

it.each([false, true])("handles a symlinked source (external=%s)", async (external) => {
  const f = await createFixture();
  const target = path.join(external ? f.root : f.workspace, "real-heartbeat.md");
  const content = external ? "outside\n" : "linked checklist\n";
  await fs.writeFile(target, content, "utf8");
  await fs.symlink(external ? target : "real-heartbeat.md", f.heartbeatPath);
  const result = await f.migrate();
  if (external) {
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("escapes the agent workspace");
    await expect(fs.lstat(f.heartbeatPath)).resolves.toMatchObject({});
  } else {
    expect(result).toMatchObject({ warnings: [], changes: [expect.any(String)] });
    expect((await f.scratch()).scratch?.content).toBe(content);
    await expect(fs.lstat(f.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe(content);
  }
});
