import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
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

const auditLine = (marker: string) => `${JSON.stringify(configAuditRecord(marker))}\n`;
const redacted = { argv: ["openclaw", "config", "set", "token", "***"] };
afterEach(resetPluginStateStoreForTests);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string, tempDir: string, sourcePath: string, rawPath: string;
beforeEach(async () => {
  stateDir = tempDirs.make("openclaw-audit-backup-");
  tempDir = path.join(stateDir, "backup-temp");
  sourcePath = path.join(stateDir, "logs", "config-audit.jsonl");
  rawPath = sourcePath + ".migrated.raw";
  await fs.mkdir(tempDir);
});
async function write(file: string, value: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
async function captureOne() {
  const { snapshots } = await createLegacyAuditBackupCapture({ stateDir, tempDir });
  expect(snapshots).toHaveLength(1);
  const asset = expectDefined(snapshots[0], "snapshot");
  return { asset, text: await fs.readFile(asset.sourcePath, "utf8") };
}
function sanitizedRows(text: string, ...secrets: string[]) {
  for (const secret of secrets) {
    expect(text).not.toContain(secret);
  }
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

it.each([
  ["logs/config-audit.jsonl", true],
  ["audit/.system-agent.jsonl.doctor-importing.2", true],
  ["logs/config-audit.jsonl.migrated.10.raw.doctor-scrub-progress", true],
  ["logs/config-audit.jsonl.migrated", false],
])(
  "keeps discovery and exclusion consistent for %s and its quarantines",
  async (relative, expected) => {
    let candidate = path.join(stateDir, relative);
    await write(candidate, "fixture");
    for (const suffix of ["", ".quarantined-2026-09-17", ".quarantined-retained-copy"]) {
      if (suffix) {
        await fs.rename(candidate, candidate + suffix);
        candidate += suffix;
      }
      expect(isLegacyAuditMigrationBackupPath(candidate, stateDir)).toBe(expected);
      await expect(hasLegacyAuditBackupSources(stateDir)).resolves.toBe(expected);
    }
  },
);

it.each(["/opt/other", "/opt/state/logs/../.."])("rejects audit paths rooted at %s", (base) => {
  const file = `${base}/logs/config-audit.jsonl.migrated.raw.quarantined-copy`;
  expect(isLegacyAuditMigrationBackupPath(file, "/opt/state")).toBe(false);
});

it("propagates audit-directory inspection failures", async () => {
  await write(path.join(stateDir, "logs"), "not a directory");
  await expect(hasLegacyAuditBackupSources(stateDir)).rejects.toMatchObject({
    code: "ENOTDIR",
  });
});

it("captures a stable active prefix while an old writer keeps appending", async () => {
  await write(
    sourcePath,
    Buffer.concat([
      Buffer.from(auditLine("initial-value-7f3c")),
      Buffer.alloc(4 * 1024 * 1024, 0x20),
    ]),
  );
  const snapshotPromise = captureOne();
  for (let index = 0; index < 8; index += 1) {
    await fs.appendFile(sourcePath, auditLine(`late-value-${index}-9a21`));
  }
  const { asset: snapshotAsset, text: snapshot } = await snapshotPromise;
  expect(snapshotAsset.archiveSourcePath).toBe(sourcePath);
  const rows = sanitizedRows(snapshot, "initial-value-7f3c", "late-value-");
  expect(rows).not.toHaveLength(0);
  expect(rows[0]).toMatchObject(redacted);
});

it.each(["claim", "raw archive"])(
  "backs up interrupted %s moves without changing live links",
  async (destination) => {
    const claimPath = path.join(path.dirname(sourcePath), ".config-audit.jsonl.doctor-importing");
    const removedPath = destination === "claim" ? sourcePath : claimPath;
    const retainedPath = destination === "claim" ? claimPath : rawPath;
    const original = auditLine("linked-value-7f3c");
    await write(removedPath, original);
    await fs.link(removedPath, retainedPath);
    const before = await fs.stat(removedPath, { bigint: true });

    for (let capture = 0; capture < 2; capture += 1) {
      const { asset: snapshot, text: sanitized } = await captureOne();
      expect(snapshot.archiveSourcePath).toBe(retainedPath);
      expect(snapshot.skippedSourcePaths).toContain(removedPath);
      expect(sanitizedRows(sanitized, "linked-value-7f3c")).toMatchObject([redacted]);
    }

    for (const livePath of [removedPath, retainedPath]) {
      expect(await fs.readFile(livePath, "utf8")).toBe(original);
      expect(await fs.stat(livePath, { bigint: true })).toMatchObject({
        dev: before.dev,
        ino: before.ino,
        nlink: 2n,
      });
    }
  },
);

it("rejects an audit source linked to an unrelated path", async () => {
  const original = auditLine("unrelated-value-7f3c");
  const unrelatedPath = path.join(path.dirname(sourcePath), "unrelated.jsonl");
  await write(sourcePath, original);
  await fs.link(sourcePath, unrelatedPath);

  await expect(createLegacyAuditBackupCapture({ stateDir, tempDir })).rejects.toThrow(/hardlink/i);
  expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
  expect(await fs.stat(unrelatedPath)).toMatchObject({ nlink: 2 });
});

it.each([false, true])("recovers scrub and append (linked journal: %s)", async (linkedJournal) => {
  const original = Buffer.from(auditLine("original-value-7f3c"));
  const later = auditLine("later-value-9a21");
  const partial = Buffer.from(original);
  const scrubbedBytes = Math.floor(partial.length / 2);
  buildAuditScrubbedContent(scrubbedBytes).copy(partial);
  await write(rawPath, Buffer.concat([partial, Buffer.from(later)]));
  await writeAuditRestoreJournal(rawPath, original, { restoredBytes: 0, scrubbedBytes });
  const restorePath = `${rawPath}.doctor-scrub-restore`;
  const stagingPath = `${rawPath}.doctor-scrub-staging`;
  const journal = await fs.readFile(restorePath, "utf8");
  if (linkedJournal) {
    await fs.link(restorePath, stagingPath);
  }

  const { asset: snapshotAsset, text: snapshot } = await captureOne();
  expect(snapshotAsset.archiveSourcePath).toBe(rawPath);
  expect(sanitizedRows(snapshot, "original-value-7f3c", "later-value-9a21")).toMatchObject([
    redacted,
    redacted,
  ]);
  if (linkedJournal) {
    for (const journalPath of [restorePath, stagingPath]) {
      expect(snapshotAsset.skippedSourcePaths).toContain(journalPath);
      expect(await fs.readFile(journalPath, "utf8")).toBe(journal);
      expect(await fs.stat(journalPath)).toMatchObject({ nlink: 2 });
    }
  }
});

it("ignores a stale restore journal after the raw archive is replaced", async () => {
  const original = Buffer.from(auditLine("old-value-7f3c"));
  const replacement = configAuditRecord("replacement-value-9a21", { event: "config.delete" });
  await write(rawPath, `${JSON.stringify(replacement)}\n`);
  await writeAuditRestoreJournal(rawPath, original);

  const { text } = await captureOne();
  expect(JSON.parse(text)).toMatchObject({ event: "config.delete", ...redacted });
});
