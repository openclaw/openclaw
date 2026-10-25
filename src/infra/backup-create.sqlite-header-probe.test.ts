import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";

// Archive-owner regression for the isolated header probe (#148796): when the
// probe cannot answer for a retained candidate, backup creation must abort
// before any archive is published instead of guessing the file is plain bytes.
describe("createBackupArchive SQLite header probe failure", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses to publish an archive when the header probe cannot read a retained candidate",
    async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-backup-probe-failure-",
          scenario: "minimal",
        },
        async (state) => {
          const dbPath = state.statePath("notes", "unreadable-candidate.db");
          await fs.mkdir(path.dirname(dbPath), { recursive: true });
          await fs.writeFile(dbPath, "retained candidate the probe cannot read");
          await fs.chmod(dbPath, 0o000);
          const outputDir = state.path("backups");
          await fs.mkdir(outputDir, { recursive: true });
          try {
            await expect(
              createBackupArchive({
                output: outputDir,
                includeWorkspace: false,
                nowMs: Date.UTC(2026, 9, 25, 4, 0, 0),
              }),
            ).rejects.toThrow(/Could not determine whether backup files are SQLite databases/);
            await expect(fs.readdir(outputDir)).resolves.toEqual([]);
          } finally {
            await fs.chmod(dbPath, 0o600).catch(() => {});
          }
        },
      );
    },
  );
});
