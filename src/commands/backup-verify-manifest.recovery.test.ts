import path from "node:path";
import { expect, it } from "vitest";
import {
  parseBackupManifest,
  parseUpdateRecoveryBackupManifest,
  verifyBackupSqliteCoverage,
} from "./backup-verify-manifest.js";

const digest = "a".repeat(64);
// These are inert inventory names; no fixture filesystem or state store is opened.
const fixtureRoot = path.resolve("recovery-manifest-fixture");
const stateDir = path.join(fixtureRoot, "state");
const databasePath = path.join(stateDir, "openclaw.sqlite");
const configPath = path.join(stateDir, "openclaw.json");
function recovery(kind: "baseline" | "candidate" | "prepared" = "baseline") {
  return {
    schemaVersion: 2,
    kind: "update-recovery",
    generation:
      kind === "baseline"
        ? { kind }
        : kind === "candidate"
          ? { kind, baselineSha256: digest }
          : { kind, baselineSha256: digest, candidateSha256: "b".repeat(64) },
    databases: [{ path: databasePath, role: "global" }],
    runId: "original-recovery",
    installRoot: path.join(fixtureRoot, "install"),
    stateDir,
    configPath,
    configPaths: [configPath],
    creator: { host: "fixture", pid: 123, startIdentity: "123" },
    drivers: [],
    createdAt: "2026-09-23T00:00:00.000Z",
    roots: [stateDir],
    excludedRoots: [],
    protectedPaths: [stateDir],
    entries: [
      { kind: "directory", sourcePath: stateDir, mode: 448 },
      {
        kind: "file",
        sourcePath: configPath,
        archivePath: "payload/1",
        size: 2,
        sha256: digest,
        sqlite: false,
        mode: 384,
      },
      {
        kind: "file",
        sourcePath: databasePath,
        archivePath: "payload/2",
        size: 4096,
        sha256: digest,
        sqlite: true,
        mode: 384,
      },
    ],
  };
}

it.each(["baseline", "candidate", "prepared"] as const)(
  "admits and retains the exact %s recovery inventory",
  (kind) => {
    const manifest = recovery(kind);
    expect(parseUpdateRecoveryBackupManifest(JSON.stringify(manifest))).toEqual(manifest);
  },
);

it("refuses two source images claiming the same payload", () => {
  const manifest = recovery();
  manifest.entries[2]!.archivePath = "payload/1";
  expect(() => parseUpdateRecoveryBackupManifest(JSON.stringify(manifest))).toThrow(
    "Duplicate update recovery payload",
  );
});

it("refuses a recovery source outside its declared roots", () => {
  const manifest = recovery();
  manifest.entries[1]!.sourcePath = path.join(fixtureRoot, "foreign", "config");
  expect(() => parseUpdateRecoveryBackupManifest(JSON.stringify(manifest))).toThrow(
    "Invalid update recovery source",
  );
});

it("requires the database inventory to name a SQLite image", () => {
  const manifest = recovery();
  manifest.entries[2]!.sqlite = false;
  expect(() => parseUpdateRecoveryBackupManifest(JSON.stringify(manifest))).toThrow(
    "Update recovery database is missing its SQLite inventory",
  );
});

it("requires the declared configuration to be present in the capture", () => {
  const manifest = recovery();
  manifest.entries.splice(1, 1);
  expect(() => parseUpdateRecoveryBackupManifest(JSON.stringify(manifest))).toThrow(
    "Update recovery manifest is missing its configuration inventory",
  );
});

it("retains ordinary capture-time SQLite inventory and requires verified coverage", () => {
  const inventory = [{ sourcePath: databasePath, role: "global" }];
  const manifest = parseBackupManifest(
    JSON.stringify({
      schemaVersion: 1,
      createdAt: "2026-09-23T00:00:00.000Z",
      archiveRoot: "backup",
      assets: [],
      sqliteSnapshots: inventory,
    }),
  );
  expect(manifest.sqliteSnapshots).toEqual(inventory);
  expect(() => verifyBackupSqliteCoverage(manifest, [], [])).toThrow(
    "Backup lacks verified canonical SQLite coverage",
  );
  expect(() =>
    parseBackupManifest(
      JSON.stringify({
        ...manifest,
        sqliteSnapshots: [...inventory, ...inventory],
      }),
    ),
  ).toThrow();
});
