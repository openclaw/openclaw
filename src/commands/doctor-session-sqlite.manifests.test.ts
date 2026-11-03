import fs from "node:fs";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore as upsertEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { assertSessionStoreMigrationComplete as assertMigrated } from "../config/sessions/startup-migration.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
} from "../infra/session-sqlite-migration-manifest.js";
import { restoreSessionSqliteMigrationRun as restoreRun } from "./doctor-session-sqlite-restore.js";
import {
  messageEvent,
  writeJson,
  writePrivateFile,
  runStoreDoctor,
  sessionScope,
  importManifest,
  expectPresent,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import {
  expectMissing,
  expectFiles,
  writeManifest,
  contains,
  containsObjects,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import {
  importLegacyStore,
  readMigrationManifest as readManifest,
  trustedMigrationTarget,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
  RECOVERY_TRANSCRIPT_LINES,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

async function createImportedManifest() {
  const store = createLegacyStore();
  return { store, ...(await importManifest(store)) };
}

function archiveFile(sessionsDir: string, name: string) {
  return path.join(path.dirname(sessionsDir), "session-sqlite-import-archive", name);
}

it("archives long Matrix thread keys with bounded names and restores their original bytes", async () => {
  const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
  const sessionKey = `agent:main:matrix:channel:${"room".repeat(32)}:thread:${"event".repeat(32)}`;
  const transcriptPath = path.join(store.sessionDir, `${"session".repeat(24)}-é.jsonl`);
  const trajectoryPath = transcriptPath.replace(/\.jsonl$/, ".trajectory.jsonl");
  fs.renameSync(store.transcriptPath, transcriptPath);
  fs.renameSync(store.trajectoryPath, trajectoryPath);
  writeJson(store.storePath, {
    [sessionKey]: { sessionId: "session-1", updatedAt: 2000, sessionFile: transcriptPath },
  });
  const originals = new Map(
    [transcriptPath, trajectoryPath, store.storePath].map((file) => [
      canonicalTestPath(file),
      fs.readFileSync(file, "utf8"),
    ]),
  );

  const { imported, manifestPath, target } = await importManifest(store);

  expect(imported.targets[0]?.issues).toEqual([]);
  for (const [sourcePath, bytes] of originals) {
    const move = expectDefined(
      target.completedMoves.find((candidate) => candidate.sourcePath === sourcePath),
      "archived original",
    );
    expect(Buffer.byteLength(path.basename(move.archivePath), "utf8")).toBeLessThanOrEqual(255);
    expectFiles(bytes, move.archivePath);
  }
  expect(new Set(target.completedMoves.map((move) => move.archivePath)).size).toBe(
    target.completedMoves.length,
  );
  expect(target.completedMoves.filter((move) => move.sessionKey === sessionKey)).toHaveLength(2);
  const artifactNames = target.completedMoves
    .filter((move) => move.sessionKey === sessionKey)
    .map((move) => path.basename(move.archivePath));
  expect(artifactNames.every((name) => /\.[a-f0-9]{16}\.imported-/.test(name))).toBe(true);
  expect((await importLegacyStore(store)).totals.importedTranscriptEvents).toBe(0);
  const restored = await restoreRun({
    manifestPath,
    trustedTargets: [trustedMigrationTarget(store)],
  });
  expect(restored.conflicts).toEqual([]);
  for (const [file, bytes] of originals) {
    expectFiles(bytes, file);
  }
});

it("repairs a retained receipt with an impossible 262-byte destination without losing originals", async () => {
  const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
  const sourcePath = fs.realpathSync.native(store.transcriptPath);
  const original = fs.readFileSync(sourcePath, "utf8");
  const move = {
    kind: "transcript",
    sessionKey: "agent:main:main",
    sourcePath,
    archivePath: archiveFile(
      path.dirname(sourcePath),
      `${"a".repeat(233)}.jsonl.imported-1788844747943`,
    ),
    artifact: {
      identity: readMigrationArtifactIdentity(sourcePath),
      classification: "imported",
      reason: "verified-import",
      dependencies: [],
      disposal: { state: "retained" },
    },
  };
  expect(Buffer.byteLength(path.basename(move.archivePath))).toBe(262);
  const receipt = {
    manifestVersion: 3,
    openClawVersion: "2026.10.8",
    runId: "session-sqlite-long-path",
    startedAt: "2026-10-08T00:00:00.000Z",
    targets: [
      {
        ...trustedMigrationTarget(store),
        storePath: fs.realpathSync.native(store.storePath),
        sqlitePath: canonicalTestPath(trustedMigrationTarget(store).sqlitePath),
        validationBeforeArchive: "passed",
        plannedMoves: [move],
        completedMoves: [],
        issues: [],
      },
    ],
  };
  const receiptPath = path.join(
    resolveSessionSqliteMigrationRunsDir(store.env),
    `${receipt.runId}.json`,
  );
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeJson(receiptPath, receipt);
  const receiptBytes = fs.readFileSync(receiptPath, "utf8");
  expect(readSessionSqliteMigrationManifest(receiptPath)?.targets[0]?.plannedMoves).toHaveLength(1);

  expect((await runStoreDoctor(store, "dry-run")).totals.issues).toBe(0);
  expectFiles(original, sourcePath);
  const { imported, manifestPath, target } = await importManifest(store);
  expect(imported.targets[0]?.issues).toEqual([]);
  const archived = expectDefined(
    target.completedMoves.find((candidate) => candidate.sourcePath === sourcePath),
    "archived transcript",
  );
  expectFiles(original, archived.archivePath);
  expectFiles(receiptBytes, receiptPath);
  expect((await runStoreDoctor(store, "dry-run")).totals.issues).toBe(0);
  const restored = await restoreRun({
    manifestPath,
    trustedTargets: [trustedMigrationTarget(store)],
  });
  expect(restored.conflicts).toEqual([]);
  expectFiles(original, sourcePath);
});

it.each([
  ["missing row", undefined, 0, false, "sqlite_entry_missing", 0, 0],
  ["different session", "other", 2, false, "sqlite_entry_mismatch", 0, 0],
  ["short transcript", "session-1", 1, false, "sqlite_transcript_count_mismatch", 1, 0],
  ["longer transcript", "session-1", 3, false, undefined, 1, 3],
  ["missing source", "session-1", 2, true, undefined, 1, 2],
] as const)(
  "validates a %s against SQLite",
  async (
    _name,
    sessionId,
    eventCount,
    missingSource,
    issueCode,
    validatedEntries,
    validatedTranscriptEvents,
  ) => {
    const events = [
      { type: "session", id: "session-1", version: 3, timestamp: "", cwd: "" },
      messageEvent("one", "user", "source"),
      messageEvent("two", "assistant", "later", "one"),
    ];
    const store = createLegacyStore({
      transcriptLines: events.slice(0, 2).map((event) => JSON.stringify(event)),
    });
    if (sessionId) {
      await importSqliteSessionRows({
        ...sessionScope(store),
        entry: { sessionId, updatedAt: 2000 },
        readTranscriptEvents: (append) => events.slice(0, eventCount).forEach(append),
      });
    }
    if (missingSource) {
      fs.rmSync(store.transcriptPath);
    }

    const report = await runStoreDoctor(store, "validate");

    const expectedIssueCodes = [
      ...(issueCode ? [issueCode] : []),
      ...(sessionId === "session-1" && !missingSource ? ["active_sqlite_transcript_jsonl"] : []),
    ];
    expect(report.totals).toMatchObject({
      issues: expectedIssueCodes.length,
      sqliteEntries: sessionId ? 1 : 0,
      validatedEntries,
      validatedTranscriptEvents,
    });
    expect(report.targets[0]?.issues.map((issue) => issue.code)).toEqual(expectedIssueCodes);
    if (issueCode) {
      expect(report.targets[0]?.issues[0]?.sessionKey).toBe("agent:main:main");
    }
    expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(Boolean(sessionId));
    if (eventCount === 3) {
      const imported = await importLegacyStore(store);
      expect(imported.targets[0]?.issues).toEqual([]);
      expectMissing(store.transcriptPath);
    }
  },
);

it("checkpoints bulk archive moves without per-file manifest rewrites", async () => {
  const store = createLegacyStore();
  const pointerPath = path.join(store.sessionDir, "session-1.trajectory-path.json");
  writeJson(pointerPath, {
    traceSchema: "openclaw-trajectory-pointer",
    schemaVersion: 1,
    sessionId: "session-1",
    runtimeFile: store.trajectoryPath,
  });
  const expectedPointerPath = canonicalTestPath(pointerPath);
  const expectedStorePath = fs.realpathSync.native(store.storePath);
  const sessions = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
  for (let index = 0; index < 64; index += 1) {
    const sessionId = `bulk-session-${index}`;
    const sessionFile = `${sessionId}.jsonl`;
    sessions[`agent:main:bulk:${index}`] = { sessionId, updatedAt: 2000 + index };
    writeJson(path.join(store.sessionDir, sessionFile), { type: "session", sessionId });
    writePrivateFile(path.join(store.sessionDir, `orphan-${index}.jsonl`), "{}\n");
  }
  writeJson(store.storePath, sessions, 2);
  writePrivateFile(path.join(store.sessionDir, "orphan collision.jsonl"), "{}\n");
  writePrivateFile(path.join(store.sessionDir, "orphan_collision.jsonl"), "{}\n");
  const expectedSources = fs.readdirSync(store.sessionDir);
  const replaceFileAtomicSync = vi.spyOn(replaceFile, "replaceFileAtomicSync");

  try {
    const { imported: report, manifest, target } = await importManifest(store);
    const manifestWrites = replaceFileAtomicSync.mock.calls.filter(([options]) =>
      options.filePath.includes("session-sqlite-migration-runs"),
    ).length;
    const plannedUnreferencedMoves = target.plannedMoves.filter(
      (move) => move.kind === "unreferenced-jsonl",
    );

    expect(manifest).toMatchObject({ runId: report.migrationRun?.runId, manifestVersion: 3 });
    expect(target).toMatchObject({
      agentId: "main",
      storePath: expectedStorePath,
      validationBeforeArchive: "passed",
    });
    expect(target.plannedMoves.map((move) => path.basename(move.sourcePath)).toSorted()).toEqual(
      expectedSources.toSorted(),
    );
    expect(new Set(plannedUnreferencedMoves.map((move) => move.archivePath)).size).toBe(67);
    expect(target.completedMoves).toHaveLength(135);
    for (const moves of [target.plannedMoves, target.completedMoves]) {
      expect(moves.filter((move) => move.kind === "unreferenced-jsonl")).toHaveLength(67);
      expect(moves.filter((move) => move.kind === "transcript")).toHaveLength(65);
    }
    expect(manifestWrites).toBeLessThan(20);
    expect(replaceFileAtomicSync).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: report.migrationRun?.manifestPath, mode: 0o600 }),
    );
    expectMissing(pointerPath);
    contains(
      report.targets[0]?.archivedTranscriptFiles.map((file) => path.basename(file)),
      expect.stringContaining("session-1.trajectory-path.json.imported-"),
    );
    containsObjects(target.plannedMoves, { kind: "trajectory", sourcePath: expectedPointerPath });
  } finally {
    replaceFileAtomicSync.mockRestore();
  }
});

it.each(["outside archive", "untrusted target"] as const)(
  "rejects a restore manifest with %s",
  async (fault) => {
    const { store, manifestPath, target, manifest } = await createImportedManifest();
    const outsideSessionsDir = path.join(store.tempDir, "outside-agent", "sessions");
    const outsideSourcePath =
      fault === "untrusted target"
        ? path.join(outsideSessionsDir, "outside.jsonl")
        : path.join(store.tempDir, "outside-source.jsonl");
    const outsideArchivePath =
      fault === "untrusted target"
        ? archiveFile(outsideSessionsDir, "outside.jsonl.imported-1")
        : path.join(store.tempDir, "outside-archive.jsonl");
    fs.mkdirSync(path.dirname(outsideArchivePath), { recursive: true });
    writePrivateFile(outsideArchivePath, '{"type":"outside"}\n');
    const move = {
      archivePath: outsideArchivePath,
      sourcePath: outsideSourcePath,
      kind: "transcript" as const,
    };
    if (fault === "untrusted target") {
      target.storePath = path.join(outsideSessionsDir, "sessions.json");
    }
    target.plannedMoves = [move];
    target.completedMoves = [move];
    writeManifest(manifestPath, manifest);
    const restore = await restoreRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });
    expect(restore).toMatchObject({
      restoredFiles: [],
      skippedFiles: [],
      conflicts: [
        {
          archivePath: manifestPath,
          sourcePath: manifestPath,
          reason:
            fault === "untrusted target"
              ? "manifest does not match a trusted session target"
              : "manifest is missing or unreadable",
        },
      ],
    });
    expectMissing(outsideSourcePath);
    expectPresent(outsideArchivePath);
  },
);

it("rejects migration sources outside the target sessions directory", () => {
  const store = createLegacyStore();
  const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
  const archivePath = archiveFile(store.sessionDir, "outside-source.jsonl.imported-1");
  writePrivateFile(outsideSourcePath, '{"type":"outside"}\n');

  expect(() =>
    assertSafeSessionSqliteMigrationMove(
      { archivePath, kind: "transcript", sourcePath: outsideSourcePath },
      trustedMigrationTarget(store),
    ),
  ).toThrow("Migration source is outside the target sessions directory");
  expectPresent(outsideSourcePath);
});

it("rejects recovery manifests with a rewritten SQLite path", async () => {
  const { store, manifestPath, manifest, target } = await createImportedManifest();
  const outsideSqlitePath = path.join(store.tempDir, "outside.sqlite");
  manifest.failedAt = "2030-01-01T00:00:00.000Z";
  target.issues = [{ code: "startup_failure", message: "failed after archive" }];
  target.sqlitePath = outsideSqlitePath;
  writeManifest(manifestPath, manifest);

  const recover = await runStoreDoctor(store, "recover");

  expect(recover.migrationRun).toBeUndefined();
  expect(recover.targets[0]?.issues[0]?.code).toBe("recover_manifest_missing");
  expectMissing(outsideSqlitePath);
});
it.each([
  { archive: "different", existing: false },
  { archive: "different", existing: true },
  { archive: "identical", existing: true },
  { archive: "missing", existing: true },
])(
  "imports a V2 index with $archive archive (existing: $existing)",
  async ({ archive, existing }) => {
    const store = createLegacyStore({
      transcriptLines: RECOVERY_TRANSCRIPT_LINES,
      entryOverrides: { label: "Legacy metadata" },
    });
    const scope = sessionScope(store);
    if (existing) {
      await upsertEntry(scope, {
        sessionId: "session-1",
        updatedAt: 3000,
        label: "Current SQLite metadata",
      });
    }
    const currentIndex = fs.readFileSync(store.storePath, "utf8");
    const archivePath = archiveFile(store.sessionDir, "sessions.json.legacy.1785542400000");
    const archivedIndex =
      archive === "identical"
        ? currentIndex
        : JSON.stringify({ "agent:main:old": { sessionId: "older-session", updatedAt: 1 } });
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    if (archive !== "missing") {
      fs.writeFileSync(archivePath, archivedIndex);
    }
    const move = { archivePath, sourcePath: store.storePath, kind: "legacy-store" };
    // v2026.8.1-beta.1 doctor-session-sqlite-migration-run.ts wrote this V2 shape.
    const receipt = {
      manifestVersion: 2,
      openClawVersion: "2026.8.1-beta.1",
      runId: "session-sqlite-1785542400000-pre-artifact",
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
      targets: [
        {
          ...trustedMigrationTarget(store),
          plannedMoves: [move],
          completedMoves: [move],
          validationBeforeArchive: "passed",
          issues: [],
        },
      ],
    };
    const manifestPath = path.join(
      resolveSessionSqliteMigrationRunsDir(store.env),
      `${receipt.runId}.json`,
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const receiptBytes = JSON.stringify(receipt);
    fs.writeFileSync(manifestPath, receiptBytes);

    const imported = await importLegacyStore(store);

    expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
    expect(readManifest(imported.migrationRun?.manifestPath).completedAt).toBeDefined();
    expect(loadSessionEntry(scope)).toMatchObject({
      sessionId: "session-1",
      label: existing && archive !== "different" ? "Current SQLite metadata" : "Legacy metadata",
    });
    const currentArchive = expectDefined(
      imported.targets[0]?.archivedLegacyStoreFiles?.[0],
      "verified current index archive",
    );
    expect(currentArchive).not.toBe(archivePath);
    expectFiles(currentIndex, currentArchive);
    if (archive !== "missing") {
      expectFiles(archivedIndex, archivePath);
    } else {
      expectMissing(archivePath);
    }
    expectFiles(receiptBytes, manifestPath);
    expect(() => assertMigrated({ cfg: {}, env: store.env })).not.toThrow();
  },
);
