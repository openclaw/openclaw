import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  hasLegacyAuditBackupSources,
  isLegacyAuditMigrationBackupPath,
} from "./backup-audit-paths.js";
import { createLegacyAuditBackupCapture } from "./state-migrations.audit-backup.js";
import {
  buildAuditScrubbedContent,
  configAuditRecord,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";

async function withBackupFixture(
  run: (fixture: {
    stateDir: string;
    tempDir: string;
    sourcePath: string;
    rawPath: string;
  }) => Promise<void>,
) {
  await withTestDir({ prefix: "openclaw-audit-backup-" }, async (rootDir) => {
    const stateDir = path.join(rootDir, "state");
    const tempDir = path.join(rootDir, "backup-temp");
    const sourcePath = path.join(stateDir, "logs", "config-audit.jsonl");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(tempDir);
    await run({ stateDir, tempDir, sourcePath, rawPath: `${sourcePath}.migrated.raw` });
  });
}

describe("legacy audit raw backup snapshots", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it.each([
    ["logs/config-audit.jsonl", true],
    ["audit/.system-agent.jsonl.doctor-importing.2", true],
    ["logs/config-audit.jsonl.migrated.10.raw.doctor-scrub-progress", true],
    ["logs/config-audit.jsonl.migrated", false],
  ])(
    "keeps discovery and exclusion consistent for %s and its quarantines",
    async (relative, expected) => {
      await withTestDir({ prefix: "openclaw-audit-backup-family-" }, async (stateDir) => {
        let sourcePath = path.join(stateDir, relative);
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, "fixture");
        for (const suffix of ["", ".quarantined-2026-09-17", ".quarantined-retained-copy"]) {
          if (suffix) {
            await fs.rename(sourcePath, sourcePath + suffix);
            sourcePath += suffix;
          }
          expect(isLegacyAuditMigrationBackupPath(sourcePath, stateDir)).toBe(expected);
          await expect(hasLegacyAuditBackupSources(stateDir)).resolves.toBe(expected);
        }
      });
    },
  );

  it("rejects paths outside the audit state root", () => {
    expect(
      isLegacyAuditMigrationBackupPath(
        "/opt/other/logs/config-audit.jsonl.migrated.raw.quarantined-copy",
        "/opt/state",
      ),
    ).toBe(false);
    expect(
      isLegacyAuditMigrationBackupPath(
        "/opt/state/logs/../../logs/config-audit.jsonl.migrated.raw.quarantined-copy",
        "/opt/state",
      ),
    ).toBe(false);
  });

  it("propagates audit-directory inspection failures", async () => {
    await withTestDir({ prefix: "openclaw-audit-backup-inspection-" }, async (stateDir) => {
      await fs.writeFile(path.join(stateDir, "logs"), "not a directory");
      await expect(hasLegacyAuditBackupSources(stateDir)).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    });
  });

  it("captures a stable active prefix while an old writer keeps appending", async () => {
    await withBackupFixture(async ({ stateDir, tempDir, sourcePath }) => {
      await fs.writeFile(
        sourcePath,
        Buffer.concat([
          Buffer.from(`${JSON.stringify(configAuditRecord("initial-value-7f3c"))}\n`),
          Buffer.alloc(4 * 1024 * 1024, 0x20),
        ]),
      );
      const snapshotPromise = createLegacyAuditBackupCapture({ stateDir, tempDir });
      for (let index = 0; index < 8; index += 1) {
        await fs.appendFile(
          sourcePath,
          `${JSON.stringify(configAuditRecord(`late-value-${index}-9a21`))}\n`,
        );
      }
      const { snapshots } = await snapshotPromise;
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");

      expect(snapshotAsset.archiveSourcePath).toBe(sourcePath);
      expect(snapshot).not.toContain("initial-value-7f3c");
      expect(snapshot).not.toContain("late-value-");
      const rows = snapshot
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).not.toHaveLength(0);
      expect(rows[0]).toMatchObject({ argv: ["openclaw", "config", "set", "token", "***"] });
    });
  });

  it("reconstructs a scrub-in-progress source and sanitizes its later append", async () => {
    await withBackupFixture(async ({ stateDir, tempDir, rawPath }) => {
      const original = Buffer.from(`${JSON.stringify(configAuditRecord("original-value-7f3c"))}\n`);
      const later = `${JSON.stringify(configAuditRecord("later-value-9a21"))}\n`;
      const partial = Buffer.from(original);
      const scrubbedBytes = Math.floor(partial.length / 2);
      buildAuditScrubbedContent(scrubbedBytes).copy(partial);
      await fs.writeFile(rawPath, Buffer.concat([partial, Buffer.from(later)]));
      await writeAuditRestoreJournal(rawPath, original, { restoredBytes: 0, scrubbedBytes });

      const { snapshots } = await createLegacyAuditBackupCapture({ stateDir, tempDir });
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");

      expect(snapshots).toHaveLength(1);
      expect(snapshotAsset.archiveSourcePath).toBe(rawPath);
      expect(snapshot).not.toContain("original-value-7f3c");
      expect(snapshot).not.toContain("later-value-9a21");
      expect(
        snapshot
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toMatchObject([
        { argv: ["openclaw", "config", "set", "token", "***"] },
        { argv: ["openclaw", "config", "set", "token", "***"] },
      ]);
    });
  });

  it("ignores a stale restore journal after the raw archive is replaced", async () => {
    await withBackupFixture(async ({ stateDir, tempDir, rawPath }) => {
      const original = Buffer.from(`${JSON.stringify(configAuditRecord("old-value-7f3c"))}\n`);
      const replacement = configAuditRecord("replacement-value-9a21", { event: "config.delete" });
      await fs.writeFile(rawPath, `${JSON.stringify(replacement)}\n`);
      await writeAuditRestoreJournal(rawPath, original);

      const { snapshots } = await createLegacyAuditBackupCapture({ stateDir, tempDir });
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = JSON.parse(await fs.readFile(snapshotAsset.sourcePath, "utf8"));
      expect(snapshot).toMatchObject({
        event: "config.delete",
        argv: ["openclaw", "config", "set", "token", "***"],
      });
    });
  });
});
