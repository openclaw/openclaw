import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createGitBackup, initializeGitBackupRepository } from "./git-backup.js";
import { writeBackupManifest } from "./git-backup.test-support.js";

const roots: string[] = [];

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(
    roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Finder metadata ownership in Git backups", () => {
  it.skipIf(process.platform === "win32").each(["empty-directory", "directory", "symlink"])(
    "refuses a Finder-named %s before cleaning any agent scopes",
    async (kind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-backup-finder-"));
      roots.push(root);
      const stateDir = path.join(root, "state");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      openOpenClawStateDatabase({ env });
      closeOpenClawStateDatabaseForTest();
      const database = {
        path: resolveOpenClawStateSqlitePath(env),
        identity: { role: "global" } as const,
      };
      const repositoryPath = path.join(root, "repository");
      await initializeGitBackupRepository({ repositoryPath, stateDir });
      const ownedAgentPath = path.join(repositoryPath, "agents", "old-agent");
      await writeBackupManifest(ownedAgentPath, "old-agent");
      const finderPath = path.join(repositoryPath, "agents", ".DS_Store");
      const payloadPath =
        kind === "symlink"
          ? path.join(root, "operator.txt")
          : path.join(finderPath, "operator.txt");
      if (kind === "symlink") {
        await fs.writeFile(payloadPath, "operator-owned\n");
        await fs.symlink(payloadPath, finderPath);
      } else {
        await fs.mkdir(finderPath);
        if (kind === "directory") {
          await fs.writeFile(payloadPath, "operator-owned\n");
        }
      }

      await expect(
        createGitBackup({ repositoryPath, stateDir, databases: [database], all: true }),
      ).rejects.toThrow(/Refusing to replace non-backup-owned path/u);
      const entry = await fs.lstat(finderPath);
      expect(kind === "symlink" ? entry.isSymbolicLink() : entry.isDirectory()).toBe(true);
      if (kind !== "empty-directory") {
        await expect(fs.readFile(payloadPath, "utf8")).resolves.toBe("operator-owned\n");
      }
      await expect(
        fs.readFile(path.join(ownedAgentPath, "manifest.json"), "utf8"),
      ).resolves.toContain('"schemaVersion":1');
    },
  );
});
