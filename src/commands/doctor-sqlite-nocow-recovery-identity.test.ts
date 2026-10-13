import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
} from "../infra/session-sqlite-migration-manifest.js";
import { reconcileNoCowRecoveryIdentities } from "./doctor-sqlite-nocow-recovery-identity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let env: NodeJS.ProcessEnv;
let archivePath: string;
let sqlitePath: string;

function writeManifest(identity: ReturnType<typeof readMigrationArtifactIdentity>) {
  const runsDir = resolveSessionSqliteMigrationRunsDir(env);
  fs.mkdirSync(runsDir, { recursive: true });
  const move = {
    kind: "database-backup",
    sourcePath: sqlitePath,
    archivePath,
    artifact: {
      identity,
      classification: "repair-original",
      reason: "pre-startup-migration-backup",
      dependencies: [],
      disposal: { state: "retained" },
    },
  };
  fs.writeFileSync(
    path.join(runsDir, "startup-migration-test.json"),
    JSON.stringify({
      manifestVersion: 3,
      runId: "startup-migration-test",
      openClawVersion: "0.0.0",
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      completedAt: new Date(Date.now() - 300_000).toISOString(),
      targets: [
        {
          agentId: "startup-migration",
          storePath: sqlitePath,
          sqlitePath,
          databaseIdentity: {
            dev: String(fs.statSync(sqlitePath).dev),
            ino: String(fs.statSync(sqlitePath).ino),
          },
          plannedMoves: [move],
          completedMoves: [move],
          issues: [],
          validationBeforeArchive: "passed",
        },
      ],
    }),
  );
}

function manifestTarget() {
  return readSessionSqliteMigrationManifest(listSessionSqliteMigrationManifestPaths(env)[0]!)!
    .targets[0]!;
}

/** The pre-exchange identity the rewrite inventory carries for each rewritten path. */
function previousIdentities(artifact: ReturnType<typeof readMigrationArtifactIdentity>) {
  return new Map<string, { dev: bigint; ino: bigint }>([
    [archivePath, { dev: BigInt(artifact.dev), ino: BigInt(artifact.ino) }],
    [
      sqlitePath,
      { dev: BigInt(fs.statSync(sqlitePath).dev), ino: BigInt(fs.statSync(sqlitePath).ino) },
    ],
  ]);
}

describe("reconcileNoCowRecoveryIdentities", () => {
  beforeEach(() => {
    root = tempDirs.make("openclaw-nocow-identity-", "/tmp");
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    sqlitePath = path.join(stateDir, "openclaw.sqlite");
    archivePath = `${sqlitePath}.pre-startup-migration-12345678-1234-8123-8123-123456789abc.bak`;
    fs.writeFileSync(sqlitePath, "live database bytes");
    fs.writeFileSync(archivePath, "original");
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("re-records the relocated identity when the copy keeps the recorded content", () => {
    const recorded = readMigrationArtifactIdentity(archivePath);
    writeManifest(recorded);
    // A real NOCOW copy replaces the file with a new inode and mtime carrying the same bytes.
    fs.rmSync(archivePath);
    fs.writeFileSync(archivePath, "original");
    const relocated = new Date(Date.now() + 1_000_000);
    fs.utimesSync(archivePath, relocated, relocated);
    const live = fs.lstatSync(archivePath, { bigint: true });
    expect(String(live.mtimeNs)).not.toBe(recorded.mtimeNs);

    expect(
      reconcileNoCowRecoveryIdentities({
        env,
        previousIdentities: previousIdentities(recorded),
        assertCurrent: () => {},
      }),
    ).toEqual([]);
    expect(manifestTarget().plannedMoves[0]!.artifact!.identity).toMatchObject({
      dev: String(live.dev),
      ino: String(live.ino),
      mtimeNs: String(live.mtimeNs),
      sha256: recorded.sha256,
    });
  });

  it("leaves the record untouched and warns when the copy lost the recorded content", () => {
    const recorded = readMigrationArtifactIdentity(archivePath);
    writeManifest(recorded);
    fs.rmSync(archivePath);
    // Same size, different bytes: an unproven relocation must never be adopted.
    fs.writeFileSync(archivePath, "originaX");

    const warnings = reconcileNoCowRecoveryIdentities({
      env,
      previousIdentities: previousIdentities(recorded),
      assertCurrent: () => {},
    });
    expect(warnings.join("\n")).toContain("left unchanged");
    expect(manifestTarget().plannedMoves[0]!.artifact!.identity).toEqual(recorded);
  });

  it("leaves a record protected when the rewritten file is not the recorded generation", () => {
    const recorded = readMigrationArtifactIdentity(archivePath);
    writeManifest(recorded);
    fs.rmSync(archivePath);
    fs.writeFileSync(archivePath, "original");
    // The path was replaced by another file before the rewrite: its pre-exchange inode is not
    // the recorded one, so the destination/artifact binding must not be refreshed.
    const previous = previousIdentities(recorded);
    previous.set(archivePath, { dev: BigInt(recorded.dev), ino: BigInt(recorded.ino) + 1n });
    const recordedDestination = manifestTarget().databaseIdentity;
    previous.set(sqlitePath, {
      dev: BigInt(recordedDestination!.dev),
      ino: BigInt(recordedDestination!.ino) + 1n,
    });

    const warnings = reconcileNoCowRecoveryIdentities({
      env,
      previousIdentities: previous,
      assertCurrent: () => {},
    });
    expect(warnings.join("\n")).toContain("not the recorded generation");
    expect(warnings.join("\n")).toContain("not the recorded destination");
    expect(manifestTarget().plannedMoves[0]!.artifact!.identity).toEqual(recorded);
    expect(manifestTarget().databaseIdentity).toEqual(recordedDestination);
  });

  it("leaves an existing manifest byte-identical when no rewritten path matches it", () => {
    const recorded = readMigrationArtifactIdentity(archivePath);
    writeManifest(recorded);
    const manifestPath = listSessionSqliteMigrationManifestPaths(env)[0]!;
    const before = fs.readFileSync(manifestPath, "utf8");

    // The rewrite touched an unrelated store: existing data must survive untouched.
    expect(
      reconcileNoCowRecoveryIdentities({
        env,
        previousIdentities: new Map([
          [path.join(root, "other", "unrelated.sqlite"), { dev: 1n, ino: 1n }],
        ]),
        assertCurrent: () => {},
      }),
    ).toEqual([]);
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
  });
});
