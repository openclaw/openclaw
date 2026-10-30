import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MigrationArtifact } from "./session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest,
} from "./session-sqlite-migration-manifest.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(proof = true) {
  const root = dirs.make("session-retirement-manifest-");
  const state = path.join(root, "state");
  const sessions = path.join(state, "agents", "main", "sessions");
  const archive = path.join(state, "agents", "main", "session-sqlite-import-archive");
  const manifestPath = path.join(state, "session-sqlite-migration-runs", "retired.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const previousArtifact: MigrationArtifact = {
    identity: { dev: "1", ino: "2", mtimeNs: "3", size: 4, sha256: "a".repeat(64) },
    classification: "imported",
    reason: "verified-import",
    dependencies: [],
    disposal: { state: "retained" },
  };
  const move = {
    kind: "unreferenced-jsonl",
    sourcePath: path.join(sessions, "history.jsonl"),
    archivePath: path.join(archive, "history.jsonl.imported-1"),
    artifact: {
      ...previousArtifact,
      identity: { ...previousArtifact.identity, ino: "5", sha256: "b".repeat(64) },
      classification: "protected",
      reason: "explicit-history-retirement",
      disposal: { state: "disposed", disposedAt: "2026-10-30T00:00:00.000Z" },
    },
    retirement: {
      acceptedAt: "2026-10-30T00:00:00.000Z",
      backupPath: path.join(root, "backup", "history.jsonl"),
      backupManifestPath: path.join(root, "backup", "retired.json"),
      backupManifestSha256: "c".repeat(64),
      ...(proof ? { previousArtifact } : {}),
    },
  };
  const manifest = {
    manifestVersion: 5,
    openClawVersion: "test",
    runId: "retired",
    startedAt: "2020-01-01T00:00:00.000Z",
    completedAt: "2020-01-01T00:00:01.000Z",
    targets: [
      {
        agentId: "main",
        storePath: path.join(sessions, "sessions.json"),
        sqlitePath: path.join(state, "agents", "main", "agent", "openclaw-agent.sqlite"),
        issues: [],
        validationBeforeArchive: "passed",
        plannedMoves: [move],
        completedMoves: [move],
      },
    ],
  };
  const read = () => {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return readSessionSqliteMigrationManifest(manifestPath);
  };
  return { state, manifestPath, manifest, move, previousArtifact, read };
}

it.each([true, false])(
  "retains original import evidence independently of retirement (proof=%s)",
  (proof) => {
    const f = fixture(proof);
    const loaded = f.read();
    expect(loaded?.manifestVersion).toBe(5);
    const move = loaded?.targets[0]?.plannedMoves[0];
    expect(move?.artifact?.identity.sha256).toBe("b".repeat(64));
    expect(move).toHaveProperty("retirement", f.move.retirement);
  },
);

it.each([
  [
    "older manifest",
    (f: ReturnType<typeof fixture>) => {
      f.manifest.manifestVersion = 4;
    },
  ],
  [
    "import classification",
    (f: ReturnType<typeof fixture>) => {
      f.move.artifact.classification = "imported";
    },
  ],
  [
    "retained disposal",
    (f: ReturnType<typeof fixture>) => {
      f.move.artifact.disposal.state = "retained";
    },
  ],
  [
    "ordinary cleanup reason",
    (f: ReturnType<typeof fixture>) => {
      f.move.artifact.reason = "verified-import";
    },
  ],
  [
    "relative backup",
    (f: ReturnType<typeof fixture>) => {
      f.move.retirement.backupPath = "backup/file";
    },
  ],
  [
    "invalid digest",
    (f: ReturnType<typeof fixture>) => {
      f.move.retirement.backupManifestSha256 = "invalid";
    },
  ],
] as const)("refuses an ambiguous retirement receipt: %s", (_name, change) => {
  const f = fixture();
  change(f);
  expect(f.read()).toBeUndefined();
});

it("keeps operator retirement evidence when completed import manifests age out", () => {
  const f = fixture();
  f.read();
  for (let index = 0; index < 51; index++) {
    fs.writeFileSync(
      path.join(path.dirname(f.manifestPath), `completed-${index}.json`),
      JSON.stringify({
        ...f.manifest,
        manifestVersion: 3,
        runId: `completed-${index}`,
        completedAt: new Date(Date.UTC(2021, 0, index + 1)).toISOString(),
        targets: [],
      }),
    );
  }
  createSessionSqliteMigrationRun({ OPENCLAW_STATE_DIR: f.state }, []);
  expect(fs.existsSync(f.manifestPath)).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(f.manifestPath), "completed-0.json"))).toBe(false);
  expect(
    readSessionSqliteMigrationManifest(f.manifestPath)?.targets[0]?.plannedMoves[0],
  ).toHaveProperty("retirement.previousArtifact", f.previousArtifact);
});
