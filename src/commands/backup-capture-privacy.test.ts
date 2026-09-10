import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupArchive } from "../infra/backup-create.js";
import { createGitBackup } from "../snapshot/git-backup.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { verifyBackupArchive } from "./backup-verify.js";

describe("private update capture exclusion", () => {
  let home: TempHomeEnv;
  let stateDir: string;
  let captureRoot: string;
  beforeEach(async () => {
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

  it.each([
    ["sqlite", "current"],
    ["git", "current"],
    ["sqlite", "other"],
    ["git", "other"],
    ["sqlite", "alias"],
    ["git", "alias"],
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
