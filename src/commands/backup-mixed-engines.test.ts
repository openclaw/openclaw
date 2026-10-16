import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createBackupArchive } from "../infra/backup-create.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

describe("mixed-engine archive backup", () => {
  it.each(["sqlite", "postgres"] as const)(
    "refuses database snapshots with a %s default before writing the archive",
    async (engine) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-backup-mixed-", scenario: "minimal" },
        async (state) => {
          await state.writeConfig({
            database: {
              engine,
              families: { workboard: { engine: engine === "sqlite" ? "postgres" : "sqlite" } },
            },
          });
          const output = state.path("backups", "backup.tar.gz");
          await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toThrow(
            "backup for mixed-engine installs is not supported yet; use a single engine",
          );
          await expect(fs.access(state.path("backups"))).rejects.toMatchObject({
            code: "ENOENT",
          });

          // Config-only capture remains the recovery path and opens no databases.
          const configBackup = await createBackupArchive({ output, onlyConfig: true });
          expect(configBackup.onlyConfig).toBe(true);
          expect(configBackup.assets.every((asset) => asset.kind === "config")).toBe(true);
          await expect(fs.stat(output)).resolves.toMatchObject({ size: expect.any(Number) });
        },
      );
    },
  );
});
