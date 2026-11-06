import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBackupArchive } from "../infra/backup-create.js";
import { withIsolatedBackupState } from "../infra/backup-create.test-support.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

describe("mixed-engine archive backup", () => {
  it("retains authored family choices through archive capture and staging restore", async () => {
    await withIsolatedBackupState(
      { layout: "state-only", prefix: "openclaw-backup-mixed-", scenario: "minimal" },
      async (state) => {
        await state.writeConfig({
          database: {
            families: { workboard: { engine: "postgres" } },
            postgres: { connection: "postgresql://unused-no-existing-workboard" },
          },
        });
        const configBytes = await fs.readFile(state.configPath);
        const output = state.path("backups", "backup.tar.gz");
        const backup = await createBackupArchive({ output, includeWorkspace: false });
        const target = state.path("restored");
        await backupRestoreCommand(createTestRuntime(), { archive: output, target });
        const configAsset = backup.assets.find(
          (asset) =>
            state.configPath.startsWith(`${asset.sourcePath}${path.sep}`) ||
            asset.sourcePath === state.configPath,
        );
        expect(configAsset).toBeDefined();
        const restoredConfig = path.join(
          target,
          configAsset!.archivePath,
          path.relative(configAsset!.sourcePath, state.configPath),
        );
        expect(await fs.readFile(restoredConfig)).toEqual(configBytes);
      },
    );
  });
});
