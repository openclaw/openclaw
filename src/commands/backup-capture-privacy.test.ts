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

  it.each(["sqlite", "git"])("refuses capture inputs in %s snapshots", async (kind) => {
    const databasePath = path.join(captureRoot, "completed", "database.sqlite");
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
