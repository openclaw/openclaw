import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import {
  corruptSqliteHeaderProbeStdoutForTest,
  failSqliteHeaderProbesForTest,
  resetSqliteHeaderProbeForTest,
  sqliteHeaderProbeChildCountForTest,
} from "./sqlite-files.js";

describe("createBackupArchive SQLite header probes", () => {
  beforeEach(() => {
    resetSqliteHeaderProbeForTest();
  });

  it("keeps batched header probes available beyond the cross-backup cache cap across repeated captures", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-probe-retention-",
        scenario: "minimal",
      },
      async (state) => {
        // More distinct non-`.sqlite` candidates than the cross-backup cache
        // cap, so without capture-scoped retention the bounded cache evicts
        // the warmed batch and discovery plus the archive walk degrade into
        // one child process per file.
        const bulkDir = state.statePath("bulk-files");
        await fs.mkdir(bulkDir, { recursive: true });
        const fileCount = 8_192 + 16; // SQLITE_HEADER_PROBE_CACHE_MAX_ENTRIES + 16
        for (let index = 0; index < fileCount; index += 1) {
          fsSync.writeFileSync(path.join(bulkDir, `plain-${index}.db`), "plain bytes\n");
        }

        const firstArchive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });
        expect(firstArchive.warnings ?? []).toEqual([]);

        // A second capture in the same process must promote warm bounded-cache
        // answers into capture retention: batch inserts can evict them before
        // classification consumes them, cascading into per-file child launches.
        const secondArchive = await createBackupArchive({
          output: state.path("backup-2.tar.gz"),
          includeWorkspace: false,
        });
        expect(secondArchive.warnings ?? []).toEqual([]);

        // One child per capture answered the whole tree: discovery prefetched
        // one batch, and both discovery and the archive walk read the retained
        // results instead of re-probing per file.
        expect(sqliteHeaderProbeChildCountForTest()).toBe(2);
      },
    );
  });

  it("fails closed when header probes cannot run, and does not cache the failure", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-probe-failure-",
        scenario: "minimal",
      },
      async (state) => {
        await fs.writeFile(state.statePath("unknown-classification.db"), "not a database\n");

        failSqliteHeaderProbesForTest(true);
        try {
          // Guessing "not a database" would archive an unknown file as
          // ordinary bytes with no warning and a verified archive, so the
          // backup must refuse instead.
          await expect(
            createBackupArchive({
              output: state.path("backup.tar.gz"),
              includeWorkspace: false,
            }),
          ).rejects.toThrow(/Could not determine whether .* is a SQLite database/u);
        } finally {
          failSqliteHeaderProbesForTest(false);
        }

        // The failed probes left no cached negatives: with the probe working
        // again, the same tree backs up normally.
        const archive = await createBackupArchive({
          output: state.path("backup-retry.tar.gz"),
          includeWorkspace: false,
        });
        expect(archive.warnings ?? []).toEqual([]);
        expect(sqliteHeaderProbeChildCountForTest()).toBeGreaterThan(0);
      },
    );
  });

  it("rejects a probe child that prints undecodable output instead of caching negatives", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-probe-noise-",
        scenario: "minimal",
      },
      async (state) => {
        await fs.writeFile(state.statePath("noisy-probe.db"), "not a database\n");

        // The noise goes through the real child process and the real stdout
        // decoding boundary: a preload printing before the JSON payload must
        // not be decoded into all-negative answers.
        corruptSqliteHeaderProbeStdoutForTest("preload noise before probe output\n");
        try {
          await expect(
            createBackupArchive({
              output: state.path("backup.tar.gz"),
              includeWorkspace: false,
            }),
          ).rejects.toThrow(/Could not determine whether .* is a SQLite database/u);
        } finally {
          corruptSqliteHeaderProbeStdoutForTest(undefined);
        }

        // With a clean probe child, the same tree backs up normally.
        const archive = await createBackupArchive({
          output: state.path("backup-retry.tar.gz"),
          includeWorkspace: false,
        });
        expect(archive.warnings ?? []).toEqual([]);
      },
    );
  });
});
