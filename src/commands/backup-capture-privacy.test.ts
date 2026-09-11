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
import { backupSqliteCreateCommand } from "./backup-sqlite.js";
import { verifyBackupArchive } from "./backup-verify.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("private update capture exclusion", () => {
  let home: TempHomeEnv;
  let stateDir: string;
  let captureRoot: string;
  beforeEach(async () => {
    resetConfigRuntimeState();
    home = await createTempHomeEnv("backup-capture-privacy-");
    stateDir = path.join(home.home, ".openclaw");
    captureRoot = `${stateDir}.update-captures`;
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
    await home.restore();
  });

  it.each(["parent", "nested"])(
    "excludes captures selected through a %s workspace",
    async (selection) => {
      const config = {
        agents: {
          ownership: "explicit",
          entries: {
            main: {
              workspace: selection === "parent" ? home.home : path.join(captureRoot, "completed"),
            },
            healthy: { workspace: `${captureRoot}-notes` },
          },
        },
      };
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(config));
      const output = path.join(path.dirname(home.home), `${path.basename(home.home)}.tar.gz`);
      try {
        const result = await createBackupArchive({ output });
        const entries: string[] = [];
        await tar.t({
          file: result.archivePath,
          onReadEntry: (entry) => {
            entries.push(entry.path);
          },
        });
        expect(entries.some((entry) => entry.endsWith("/private.txt"))).toBe(false);
        expect(entries.some((entry) => entry.endsWith("/healthy.txt"))).toBe(true);
        await verifyBackupArchive(result.archivePath);
        expect(await fs.readFile(path.join(captureRoot, "completed", "private.txt"), "utf8")).toBe(
          "retained raw bytes",
        );
      } finally {
        await fs.rm(output, { force: true });
      }
    },
  );

  it("excludes another state's paired capture root from a public archive", async () => {
    const otherState = path.join(home.home, "profile-b");
    const otherCapture = `${otherState}.update-captures`;
    const healthy = `${otherCapture}-notes`;
    // A same-suffix directory without a paired owner is ordinary workspace data.
    const unowned = path.join(home.home, "research.update-captures");
    for (const directory of [otherState, path.join(otherCapture, "run"), healthy, unowned]) {
      await fs.mkdir(directory, { recursive: true });
    }
    const privateFile = path.join(otherCapture, "run", "private-b.txt");
    await fs.writeFile(privateFile, "synthetic private B bytes");
    await fs.writeFile(path.join(otherCapture, "run", "config.json"), '{"synthetic":"raw B"}');
    await fs.writeFile(path.join(healthy, "healthy-b.txt"), "healthy B neighbor");
    await fs.writeFile(path.join(unowned, "research.txt"), "ordinary research");
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: { workspace: home.home } } },
      }),
    );
    const output = path.join(
      path.dirname(home.home),
      `${path.basename(home.home)}-cross-state.tar.gz`,
    );
    try {
      const result = await createBackupArchive({ output });
      const entries: string[] = [];
      await tar.t({
        file: result.archivePath,
        onReadEntry: (entry) => {
          entries.push(entry.path);
        },
      });
      await verifyBackupArchive(result.archivePath);
      expect(entries.some((entry) => entry.endsWith("/healthy-b.txt"))).toBe(true);
      expect(entries.some((entry) => entry.endsWith("/research.txt"))).toBe(true);
      expect(await fs.readFile(privateFile, "utf8")).toBe("synthetic private B bytes");
      expect(entries.some((entry) => entry.includes("/profile-b.update-captures/"))).toBe(false);
    } finally {
      await fs.rm(output, { force: true });
    }
  });

  it.each(["parent", "nested alias"])(
    "excludes marked orphaned and relocated artifacts from a %s workspace",
    async (selection) => {
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
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            ownership: "explicit",
            entries: {
              main: { workspace: selection === "parent" ? home.home : alias },
              healthy: { workspace: healthy },
            },
          },
        }),
      );
      const output = path.join(
        path.dirname(home.home),
        `${path.basename(home.home)}-marker.tar.gz`,
      );
      try {
        const result = await createBackupArchive({ output });
        const entries: string[] = [];
        await tar.t({
          file: result.archivePath,
          onReadEntry: (entry) => {
            entries.push(entry.path);
          },
        });
        expect(entries.some((entry) => entry.endsWith("/healthy.txt"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/manifest.json"))).toBe(true);
        expect(entries.some((entry) => entry.endsWith("/raw.txt"))).toBe(false);
        await verifyBackupArchive(result.archivePath);
        for (const directory of [orphanedRoot, moved, movedRoot]) {
          expect(await fs.readFile(path.join(directory, "raw.txt"), "utf8")).toBe(
            "synthetic retained bytes",
          );
        }
      } finally {
        await fs.rm(output, { force: true });
      }
    },
  );

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
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          ownership: "explicit",
          entries: { main: { workspace: `${captureRoot}-notes` } },
        },
      }),
    );
    const output = path.join(path.dirname(home.home), `${path.basename(home.home)}-skill.tar.gz`);
    try {
      const result = await createBackupArchive({ output });
      const entries: string[] = [];
      await tar.t({
        file: result.archivePath,
        onReadEntry: (entry) => {
          entries.push(entry.path);
        },
      });
      expect(entries.some((entry) => entry.endsWith("/SKILL.md"))).toBe(false);
      expect(entries.some((entry) => entry.endsWith("/healthy.txt"))).toBe(true);
      await verifyBackupArchive(result.archivePath);
      expect(await fs.readFile(path.join(external, "SKILL.md"), "utf8")).toBe(skill);
      expect(await fs.readFile(marker, "utf8")).toBe("openclaw-private-update-capture-v1\n");
    } finally {
      await fs.rm(output, { force: true });
    }
  });

  it.each(["valid", "invalid with duplicate", "valid with duplicate"])(
    "checks a %s lexical marker before deduplicating an outward workspace alias",
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
      const alias = path.join(marked, "workspace");
      await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            ownership: "explicit",
            entries: {
              main: { workspace: alias },
              healthy: { workspace: `${captureRoot}-notes` },
              ...(mode.includes("duplicate") ? { independent: { workspace: outside } } : {}),
            },
          },
        }),
      );
      const output = path.join(
        path.dirname(home.home),
        `${path.basename(home.home)}-outward.tar.gz`,
      );
      try {
        if (mode.startsWith("invalid")) {
          await expect(createBackupArchive({ output })).rejects.toThrow(
            "Private update capture marker",
          );
          await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const result = await createBackupArchive({ output });
          const entries: string[] = [];
          await tar.t({
            file: result.archivePath,
            onReadEntry: (entry) => {
              entries.push(entry.path);
            },
          });
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
      } finally {
        await fs.rm(output, { force: true });
      }
    },
  );

  it.each(["unpaired", "current", "other"])(
    "refuses publication for an invalid privacy marker in a %s capture directory",
    async (owner) => {
      const workspace = owner === "unpaired" ? path.join(home.home, "workspace") : home.home;
      const otherState = path.join(home.home, "other-state");
      if (owner === "other") {
        await fs.mkdir(otherState);
      }
      const privateDir =
        owner === "current"
          ? captureRoot
          : owner === "other"
            ? `${otherState}.update-captures`
            : path.join(workspace, "incomplete");
      await fs.mkdir(privateDir, { recursive: true });
      await fs.writeFile(path.join(privateDir, ".openclaw-private-update-capture"), "incomplete");
      await fs.writeFile(path.join(privateDir, "raw.txt"), "synthetic incomplete bytes");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: { ownership: "explicit", entries: { main: { workspace } } },
        }),
      );
      const output = path.join(
        path.dirname(home.home),
        `${path.basename(home.home)}-invalid.tar.gz`,
      );
      try {
        await expect(createBackupArchive({ output })).rejects.toThrow(
          "Private update capture marker",
        );
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(privateDir, "raw.txt"), "utf8")).toBe(
          "synthetic incomplete bytes",
        );
      } finally {
        await fs.rm(output, { force: true });
      }
    },
  );

  it.each([
    ["sqlite", "current"],
    ["git", "current"],
    ["sqlite", "other"],
    ["git", "other"],
    ["sqlite", "alias"],
    ["git", "alias"],
    ["sqlite", "marked relocated alias"],
    ["git", "marked relocated alias"],
  ])("refuses capture inputs in %s snapshots from %s state", async (kind, owner) => {
    let selectedRoot = captureRoot;
    if (owner !== "current") {
      const otherState = path.join(home.home, "profile-b");
      await fs.mkdir(otherState);
      selectedRoot = `${otherState}.update-captures`;
      await fs.mkdir(path.join(selectedRoot, "completed"), { recursive: true });
      if (owner === "alias") {
        const alias = path.join(home.home, "capture-alias");
        await fs.symlink(selectedRoot, alias, process.platform === "win32" ? "junction" : "dir");
        selectedRoot = alias;
      }
    }
    if (owner === "marked relocated alias") {
      const moved = path.join(home.home, "relocated");
      await fs.rename(selectedRoot, moved);
      await fs.writeFile(
        path.join(moved, ".openclaw-private-update-capture"),
        "openclaw-private-update-capture-v1\n",
      );
      await fs.symlink(moved, selectedRoot, process.platform === "win32" ? "junction" : "dir");
      await fs.rmdir(path.join(home.home, "profile-b"));
    }
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

  it.each(["valid", "invalid"])(
    "refuses a %s marked agent root selection before canonicalization",
    async (mode) => {
      const marked = path.join(home.home, "marked-agent-parent");
      const target = path.join(home.home, "external-agent");
      await fs.mkdir(marked);
      await fs.mkdir(target);
      const marker = path.join(marked, ".openclaw-private-update-capture");
      const markerBytes = mode === "valid" ? "openclaw-private-update-capture-v1\n" : "incomplete";
      await fs.writeFile(marker, markerBytes);
      await fs.writeFile(path.join(target, "agent-private.txt"), "synthetic private agent bytes");
      const alias = path.join(marked, "agent");
      await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            ownership: "explicit",
            entries: { main: { agentDir: alias, workspace: `${captureRoot}-notes` } },
          },
        }),
      );
      const output = path.join(path.dirname(home.home), `${path.basename(home.home)}-agent.tar.gz`);
      try {
        await expect(createBackupArchive({ output })).rejects.toThrow("Private update capture");
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(target, "agent-private.txt"), "utf8")).toBe(
          "synthetic private agent bytes",
        );
        expect(await fs.readFile(marker, "utf8")).toBe(markerBytes);
      } finally {
        await fs.rm(output, { force: true });
      }
    },
  );

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
      await fs.writeFile(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          agents: {
            ownership: "explicit",
            entries: {
              main: {
                ...(role === "agent" ? { agentDir: alias } : {}),
                workspace: `${captureRoot}-notes`,
              },
            },
          },
        }),
      );
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

  it.each([false, true])(
    "refuses a raw capture selected as config, onlyConfig=%s",
    async (onlyConfig) => {
      const configPath = path.join(captureRoot, "completed", "config.json");
      await fs.writeFile(configPath, "{}");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      await expect(createBackupArchive({ onlyConfig, dryRun: true })).rejects.toThrow(
        "Private update captures are excluded",
      );
    },
  );
});
