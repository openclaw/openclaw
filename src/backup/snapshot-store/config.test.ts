import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSnapshotStoreConfig } from "./config.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("resolveSnapshotStoreConfig", () => {
  it("rejects backup targets that resolve into the live state directory via symlink", async () => {
    const homeDir = await createTempDir("openclaw-backup-config-home-");
    const stateDir = path.join(homeDir, ".openclaw");
    const linkedTarget = path.join(homeDir, "BackupsLink");

    await fs.mkdir(stateDir, { recursive: true });
    await fs.symlink(stateDir, linkedTarget);

    await expect(
      resolveSnapshotStoreConfig({
        config: {
          backup: {
            target: linkedTarget,
            encryption: { key: "secret" },
          },
        },
        env: {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
        },
      }),
    ).rejects.toThrow("backup.target must not be inside the live state directory.");
  });

  it("rejects backup targets that live inside a configured workspace", async () => {
    const homeDir = await createTempDir("openclaw-backup-config-workspace-");
    const workspaceDir = path.join(homeDir, "workspace");
    const targetDir = path.join(workspaceDir, "Backups");

    await fs.mkdir(targetDir, { recursive: true });

    await expect(
      resolveSnapshotStoreConfig({
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
          backup: {
            target: targetDir,
            encryption: { key: "secret" },
          },
        },
        env: {
          ...process.env,
          HOME: homeDir,
        },
      }),
    ).rejects.toThrow("backup.target must not be inside a workspace being backed up.");
  });
});
