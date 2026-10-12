import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { createBackupArchive } from "../infra/backup-create.js";
import { createGitBackup } from "../snapshot/git-backup.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { backupGitCreateCommand } from "./backup-git.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { backupSqliteCreateCommand } from "./backup-sqlite.js";
import { verifyBackupArchive } from "./backup-verify.js";
import { backupCreateCommand } from "./backup.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    onReadEntry: (entry) => {
      entries.push(entry.path);
    },
  });
  return entries;
}

describe("private update capture exclusion", () => {
  let home: TempHomeEnv;
  let stateDir: string;
  let captureRoot: string;
  let output: string;

  async function configureAgents(
    entries: Record<string, { workspace?: string; agentDir?: string }>,
  ) {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({ agents: { ownership: "explicit", entries } }),
    );
  }

  beforeEach(async () => {
    resetConfigRuntimeState();
    home = await createTempHomeEnv("backup-capture-privacy-");
    stateDir = path.join(home.home, ".openclaw");
    captureRoot = `${stateDir}.update-captures`;
    output = path.join(path.dirname(home.home), `${path.basename(home.home)}.tar.gz`);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    await fs.mkdir(path.join(captureRoot, "completed"), { recursive: true });
    await fs.writeFile(path.join(captureRoot, "completed", "private.txt"), "retained raw bytes");
    await fs.mkdir(`${captureRoot}-notes`);
    await fs.writeFile(
      path.join(`${captureRoot}-notes`, "healthy.txt"),
      "ordinary workspace bytes",
    );
  });
  afterEach(async () => {
    resetConfigRuntimeState();
    vi.unstubAllEnvs();
    try {
      await fs.rm(output, { force: true });
    } finally {
      await home.restore();
    }
  });

  it("excludes a capture whose paired owner is a directory link", async () => {
    const otherState = path.join(home.home, "profile-b");
    const otherCapture = `${otherState}.update-captures`;
    const healthy = `${otherCapture}-notes`;
    // A same-suffix directory without a paired owner is ordinary workspace data.
    const unowned = path.join(home.home, "research.update-captures");
    for (const directory of [otherState, path.join(otherCapture, "run"), healthy, unowned]) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.rename(otherState, otherState + "-target");
    await fs.symlink(
      otherState + "-target",
      otherState,
      process.platform === "win32" ? "junction" : "dir",
    );
    const privateFile = path.join(otherCapture, "run", "private-b.txt");
    await fs.writeFile(privateFile, "synthetic private B bytes");
    await fs.writeFile(path.join(otherCapture, "run", "config.json"), '{"synthetic":"raw B"}');
    await fs.writeFile(path.join(healthy, "healthy-b.txt"), "healthy B neighbor");
    await fs.writeFile(path.join(unowned, "research.txt"), "ordinary research");
    await configureAgents({ main: { workspace: home.home } });
    const runtime = createTestRuntime();
    const result = await backupCreateCommand(runtime, { output, verify: true });
    const entries = await listArchiveEntries(result.archivePath);
    await verifyBackupArchive(result.archivePath);
    const restored = path.join(home.home, "restored-paired");
    await backupRestoreCommand(runtime, { archive: result.archivePath, target: restored });
    const workspace = result.assets.find((asset) => asset.kind === "workspace");
    expect(workspace).toBeDefined();
    if (workspace) {
      await expect(
        fs.stat(
          path.join(
            restored,
            workspace.archivePath,
            "profile-b.update-captures",
            "run",
            "private-b.txt",
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(entries.some((entry) => entry.endsWith("/healthy-b.txt"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("/research.txt"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("/private.txt"))).toBe(false);
    expect(await fs.readFile(privateFile, "utf8")).toBe("synthetic private B bytes");
    expect(entries.some((entry) => entry.includes("/profile-b.update-captures/"))).toBe(false);
  });

  it("refuses a config-only backup selected through a linked capture root", async () => {
    const owner = path.join(home.home, "other-state");
    const target = path.join(home.home, "legacy-data");
    await fs.mkdir(owner);
    await fs.mkdir(target);
    const configPath = path.join(target, "config.json");
    await fs.writeFile(configPath, "{}");
    const captureAlias = owner + ".update-captures";
    await fs.symlink(target, captureAlias, process.platform === "win32" ? "junction" : "dir");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(captureAlias, "config.json"));
    await expect(
      backupCreateCommand(createTestRuntime(), { output, onlyConfig: true, verify: true }),
    ).rejects.toThrow("Private update captures are excluded from backups and support exports.");
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(configPath, "utf8")).toBe("{}");
  });

  it("excludes marked orphaned and relocated artifacts from a parent workspace", async () => {
    const otherState = path.join(home.home, "profile-b");
    const orphanedRoot = `${otherState}.update-captures`;
    const moved = path.join(home.home, "relocated-artifact");
    const movedRoot = path.join(home.home, "relocated-root");
    const healthy = path.join(home.home, "research.update-captures");
    for (const directory of [otherState, orphanedRoot, moved, movedRoot, healthy]) {
      await fs.mkdir(directory);
    }
    // Fixed producer contract, independent of the implementation's constants.
    for (const directory of [orphanedRoot, moved, movedRoot]) {
      await fs.writeFile(
        path.join(directory, ".openclaw-private-update-capture"),
        "openclaw-private-update-capture-v1\n",
      );
      await fs.writeFile(path.join(directory, "raw.txt"), "synthetic retained bytes");
    }
    await fs.rename(otherState, `${otherState}-renamed`);
    await fs.writeFile(path.join(healthy, "healthy.txt"), "ordinary workspace bytes");
    await fs.writeFile(
      path.join(healthy, "manifest.json"),
      '{"schema":"openclaw.update-capture.v1"}',
    );
    const alias = path.join(home.home, "artifact-alias");
    await fs.symlink(moved, alias, process.platform === "win32" ? "junction" : "dir");
    await configureAgents({
      main: { workspace: home.home },
      healthy: { workspace: healthy },
    });
    const result = await createBackupArchive({ output });
    const entries = await listArchiveEntries(result.archivePath);
    expect(entries.some((entry) => entry.endsWith("/healthy.txt"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("/manifest.json"))).toBe(true);
    expect(entries.some((entry) => entry.endsWith("/raw.txt"))).toBe(false);
    await verifyBackupArchive(result.archivePath);
    for (const directory of [orphanedRoot, moved, movedRoot]) {
      expect(await fs.readFile(path.join(directory, "raw.txt"), "utf8")).toBe(
        "synthetic retained bytes",
      );
    }
  });

  it("does not promote a managed skill through a marked lexical parent", async () => {
    const skills = path.join(stateDir, "skills");
    const external = path.join(home.home, "external-skill");
    await fs.mkdir(skills);
    await fs.mkdir(external);
    const marker = path.join(skills, ".openclaw-private-update-capture");
    await fs.writeFile(marker, "openclaw-private-update-capture-v1\n");
    const skill = "---\nname: demo\ndescription: Synthetic private skill\n---\n";
    await fs.writeFile(path.join(external, "SKILL.md"), skill);
    await fs.symlink(
      external,
      path.join(skills, "demo"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await configureAgents({ main: { workspace: `${captureRoot}-notes` } });
    const result = await createBackupArchive({ output });
    const entries = await listArchiveEntries(result.archivePath);
    expect(entries.some((entry) => entry.endsWith("/SKILL.md"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith("/healthy.txt"))).toBe(true);
    await verifyBackupArchive(result.archivePath);
    expect(await fs.readFile(path.join(external, "SKILL.md"), "utf8")).toBe(skill);
    expect(await fs.readFile(marker, "utf8")).toBe("openclaw-private-update-capture-v1\n");
  });

  it.each(["invalid with duplicate", "valid with duplicate", "valid via alias"])(
    "backupCreateCommand checks real and resolved ancestors for a %s workspace",
    async (mode) => {
      const outside = path.join(home.home, "unmarked-target");
      const marked = path.join(home.home, "marked-parent");
      await fs.mkdir(outside);
      await fs.mkdir(marked);
      const marker = path.join(marked, ".openclaw-private-update-capture");
      const markerBytes = mode.startsWith("invalid")
        ? "incomplete"
        : "openclaw-private-update-capture-v1\n";
      await fs.writeFile(marker, markerBytes);
      const raw = path.join(outside, "outward.txt");
      await fs.writeFile(raw, "synthetic outward bytes");
      let alias = path.join(marked, "workspace");
      await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
      if (mode.endsWith("via alias")) {
        const markedAlias = path.join(home.home, "marked-alias");
        await fs.symlink(marked, markedAlias, process.platform === "win32" ? "junction" : "dir");
        alias = path.join(markedAlias, "workspace");
      }
      await configureAgents({
        main: { workspace: alias },
        healthy: { workspace: `${captureRoot}-notes` },
        ...(mode.includes("duplicate") ? { independent: { workspace: outside } } : {}),
      });
      if (mode.startsWith("invalid")) {
        await expect(backupCreateCommand(createTestRuntime(), { output })).rejects.toThrow(
          "Private update capture marker",
        );
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const result = await backupCreateCommand(createTestRuntime(), { output });
        const entries = await listArchiveEntries(result.archivePath);
        expect(entries.some((entry) => entry.endsWith("/outward.txt"))).toBe(
          mode.includes("duplicate"),
        );
        expect(entries.some((entry) => entry.endsWith("/healthy.txt"))).toBe(true);
        await verifyBackupArchive(result.archivePath);
        expect(result.skipped).toContainEqual(
          expect.objectContaining({ kind: "workspace", sourcePath: alias, reason: "private" }),
        );
      }
      expect(await fs.readFile(raw, "utf8")).toBe("synthetic outward bytes");
      expect(await fs.readFile(marker, "utf8")).toBe(markerBytes);
      expect(await fs.realpath(alias)).toBe(await fs.realpath(outside));
    },
  );

  it("refuses publication for an invalid marker even in a known capture directory", async () => {
    await fs.writeFile(path.join(captureRoot, ".openclaw-private-update-capture"), "incomplete");
    await fs.writeFile(path.join(captureRoot, "raw.txt"), "synthetic incomplete bytes");
    await configureAgents({ main: { workspace: home.home } });
    await expect(createBackupArchive({ output })).rejects.toThrow("Private update capture marker");
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(captureRoot, "raw.txt"), "utf8")).toBe(
      "synthetic incomplete bytes",
    );
  });

  it.each(["sqlite", "git"])("refuses relocated capture aliases in %s snapshots", async (kind) => {
    const selectedRoot = path.join(home.home, "profile-b.update-captures");
    const moved = path.join(home.home, "relocated");
    await fs.mkdir(path.join(moved, "completed"), { recursive: true });
    await fs.writeFile(
      path.join(moved, ".openclaw-private-update-capture"),
      "openclaw-private-update-capture-v1\n",
    );
    await fs.symlink(moved, selectedRoot, process.platform === "win32" ? "junction" : "dir");
    const databasePath = path.join(selectedRoot, "completed", "database.sqlite");
    const source = new DatabaseSync(databasePath);
    source.exec(OPENCLAW_STATE_SCHEMA_SQL);
    source.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION}`);
    source
      .prepare(
        "INSERT INTO schema_meta(meta_key,role,schema_version,created_at,updated_at) VALUES('primary','global',?,1,1)",
      )
      .run(OPENCLAW_STATE_SCHEMA_VERSION);
    source.close();
    const before = await fs.readFile(databasePath);
    const database = { path: databasePath, identity: { role: "global" as const } };
    const repositoryPath = path.join(home.home, "backup-repository");
    const create =
      kind === "sqlite"
        ? createLocalSqliteSnapshotProvider({ repositoryPath }).create(database)
        : createGitBackup({
            repositoryPath,
            stateDir,
            databases: [database],
            gitEnv: {
              ...process.env,
              GIT_AUTHOR_NAME: "OpenClaw Test",
              GIT_AUTHOR_EMAIL: "test@example.invalid",
              GIT_COMMITTER_NAME: "OpenClaw Test",
              GIT_COMMITTER_EMAIL: "test@example.invalid",
            },
          });
    await expect(create).rejects.toThrow("Private update captures are excluded");
    expect(await fs.readFile(databasePath)).toEqual(before);
  });

  it("refuses a marked agent root selection before canonicalization", async () => {
    const marked = path.join(home.home, "marked-agent-parent");
    const target = path.join(home.home, "external-agent");
    await fs.mkdir(marked);
    await fs.mkdir(target);
    const marker = path.join(marked, ".openclaw-private-update-capture");
    const markerBytes = "openclaw-private-update-capture-v1\n";
    await fs.writeFile(marker, markerBytes);
    await fs.writeFile(path.join(target, "agent-private.txt"), "synthetic private agent bytes");
    const alias = path.join(marked, "agent");
    await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await configureAgents({ main: { agentDir: alias, workspace: `${captureRoot}-notes` } });
    await expect(createBackupArchive({ output })).rejects.toThrow("Private update capture");
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(target, "agent-private.txt"), "utf8")).toBe(
      "synthetic private agent bytes",
    );
    expect(await fs.readFile(marker, "utf8")).toBe(markerBytes);
  });

  it.each([
    ["sqlite", "global"],
    ["git", "global"],
    ["sqlite", "agent"],
    ["git", "agent"],
  ])(
    "refuses lexical markers before %s %s database selection and keeps healthy aliases usable",
    async (kind, role) => {
      const target = path.join(home.home, "external-database");
      await fs.mkdir(target);
      const marked =
        role === "global"
          ? path.join(stateDir, "state")
          : path.join(home.home, "marked-agent-parent");
      await fs.mkdir(marked, { recursive: true });
      const marker = path.join(marked, ".openclaw-private-update-capture");
      const databasePath = path.join(
        target,
        role === "global" ? "openclaw.sqlite" : "openclaw-agent.sqlite",
      );
      const version =
        role === "global" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
      const db = new DatabaseSync(databasePath);
      db.exec(role === "global" ? OPENCLAW_STATE_SCHEMA_SQL : OPENCLAW_AGENT_SCHEMA_SQL);
      db.exec(`PRAGMA user_version=${version}`);
      db.prepare(
        "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES('primary',?,?,?,1,1)",
      ).run(role, version, role === "agent" ? "main" : null);
      db.close();
      const alias =
        role === "global" ? path.join(marked, "openclaw.sqlite") : path.join(marked, "agent");
      await fs.symlink(
        role === "global" ? databasePath : target,
        alias,
        role === "global" ? "file" : process.platform === "win32" ? "junction" : "dir",
      );
      await configureAgents({
        main: {
          ...(role === "agent" ? { agentDir: alias } : {}),
          workspace: `${captureRoot}-notes`,
        },
      });
      for (const key of ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]) {
        vi.stubEnv(key, "OpenClaw Test");
      }
      for (const key of ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]) {
        vi.stubEnv(key, "test@example.invalid");
      }
      const runtime = createTestRuntime();
      const repository = path.join(home.home, "command-backup");
      const create = () =>
        kind === "sqlite"
          ? backupSqliteCreateCommand(runtime, {
              repository,
              ...(role === "global" ? { global: true } : { agent: "main" }),
            })
          : backupGitCreateCommand(runtime, {
              repository,
              ...(role === "global" ? { global: true } : { agents: ["main"] }),
            });
      const before = await fs.readFile(databasePath);
      for (const bytes of ["incomplete", "openclaw-private-update-capture-v1\n"]) {
        await fs.writeFile(marker, bytes);
        await expect(create()).rejects.toThrow("Private update capture");
        await expect(fs.stat(repository)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(databasePath)).toEqual(before);
        expect(await fs.readFile(marker, "utf8")).toBe(bytes);
      }
      // Only remove this fixture-owned marker. The same ordinary alias must remain usable.
      await fs.unlink(marker);
      await expect(create()).resolves.toBeDefined();
      expect((await fs.readdir(repository)).length).toBeGreaterThan(0);
    },
  );
});
