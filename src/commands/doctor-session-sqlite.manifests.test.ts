import fs from "node:fs";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { assertSafeSessionSqliteMigrationMove } from "../infra/session-sqlite-migration-manifest.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  trustedMigrationTarget,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

const { createLegacyStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([
    ["missing row", undefined, 0, false, "sqlite_entry_missing", 0, 0],
    ["different session", "other", 2, false, "sqlite_entry_mismatch", 0, 0],
    ["short transcript", "session-1", 1, false, "sqlite_transcript_count_mismatch", 1, 0],
    ["matching transcript", "session-1", 2, false, undefined, 1, 2],
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
        {
          type: "message",
          id: "one",
          parentId: null,
          message: { role: "user", content: "source" },
        },
        {
          type: "message",
          id: "two",
          parentId: "one",
          message: { role: "assistant", content: "later" },
        },
      ];
      const store = createLegacyStore({
        transcriptLines: events.slice(0, 2).map((event) => JSON.stringify(event)),
      });
      if (sessionId) {
        await importSqliteSessionRows({
          agentId: "main",
          env: store.env,
          sessionKey: "agent:main:main",
          storePath: store.storePath,
          entry: { sessionId, updatedAt: 2000 },
          readTranscriptEvents: (append) => events.slice(0, eventCount).forEach(append),
        });
      }
      if (missingSource) {
        fs.rmSync(store.transcriptPath);
      }

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "validate",
        store: store.storePath,
      });

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
        expect(fs.existsSync(store.transcriptPath)).toBe(false);
      }
    },
  );

  it("writes a migration manifest with planned and completed archive moves", async () => {
    const store = createLegacyStore();
    const expectedStorePath = fs.realpathSync.native(store.storePath);

    const report = await importLegacyStore(store);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    const target = expectDefined(manifest.targets[0], "manifest.targets[0] test invariant");

    expect(report.migrationRun?.runId).toBe(manifest.runId);
    expect(manifest.manifestVersion).toBe(3);
    expect(target).toMatchObject({
      agentId: "main",
      storePath: expectedStorePath,
      validationBeforeArchive: "passed",
    });
    expect(target.completedMoves).toHaveLength(4);
    expect(target.plannedMoves.map((move) => path.basename(move.sourcePath)).toSorted()).toEqual([
      "orphan.jsonl",
      "session-1.jsonl",
      "session-1.trajectory.jsonl",
      "sessions.json",
    ]);
  });

  it("checkpoints bulk archive moves without per-file manifest rewrites", async () => {
    const store = createLegacyStore();
    const sessions = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    for (let index = 0; index < 64; index += 1) {
      const sessionId = `bulk-session-${index}`;
      const sessionFile = `${sessionId}.jsonl`;
      sessions[`agent:main:bulk:${index}`] = {
        channel: "cli",
        chatType: "direct",
        sessionFile,
        sessionId,
        updatedAt: 2000 + index,
      };
      fs.writeFileSync(
        path.join(store.sessionDir, sessionFile),
        `${JSON.stringify({ type: "session", sessionId })}\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(store.sessionDir, `orphan-${index}.jsonl`), "{}\n", {
        mode: 0o600,
      });
    }
    fs.writeFileSync(store.storePath, JSON.stringify(sessions, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(store.sessionDir, "orphan collision.jsonl"), "{}\n", {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(store.sessionDir, "orphan_collision.jsonl"), "{}\n", {
      mode: 0o600,
    });
    const replaceFileAtomicSync = vi.spyOn(replaceFile, "replaceFileAtomicSync");

    try {
      const report = await importLegacyStore(store);
      const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
      const manifestWrites = replaceFileAtomicSync.mock.calls.filter(([options]) =>
        options.filePath.includes("session-sqlite-migration-runs"),
      ).length;
      const plannedUnreferencedMoves =
        manifest.targets[0]?.plannedMoves.filter((move) => move.kind === "unreferenced-jsonl") ??
        [];
      const plannedTranscriptMoves =
        manifest.targets[0]?.plannedMoves.filter((move) => move.kind === "transcript") ?? [];

      expect(plannedUnreferencedMoves).toHaveLength(67);
      expect(new Set(plannedUnreferencedMoves.map((move) => move.archivePath)).size).toBe(67);
      expect(plannedTranscriptMoves).toHaveLength(65);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "unreferenced-jsonl"),
      ).toHaveLength(67);
      expect(
        manifest.targets[0]?.completedMoves.filter((move) => move.kind === "transcript"),
      ).toHaveLength(65);
      expect(manifestWrites).toBeLessThan(20);
      expect(replaceFileAtomicSync).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: report.migrationRun?.manifestPath,
          mode: 0o600,
          tempPrefix: path.basename(report.migrationRun?.manifestPath ?? ""),
        }),
      );
    } finally {
      replaceFileAtomicSync.mockRestore();
    }
  });

  it("archives legacy trajectory pointer files with imported transcripts", async () => {
    const store = createLegacyStore();
    const pointerPath = path.join(store.sessionDir, "session-1.trajectory-path.json");
    fs.writeFileSync(
      pointerPath,
      `${JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: store.trajectoryPath,
      })}\n`,
      { mode: 0o600 },
    );
    const expectedPointerPath = canonicalTestPath(pointerPath);

    const report = await importLegacyStore(store);
    const archivedNames =
      report.targets[0]?.archivedTranscriptFiles.map((filePath) => path.basename(filePath)) ?? [];

    expect(fs.existsSync(pointerPath)).toBe(false);
    expect(archivedNames).toEqual(
      expect.arrayContaining([expect.stringContaining("session-1.trajectory-path.json.imported-")]),
    );
    expect(
      readMigrationManifest(report.migrationRun?.manifestPath).targets[0]?.plannedMoves,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trajectory",
          sourcePath: expectedPointerPath,
        }),
      ]),
    );
  });

  it("rejects malformed restore manifests without throwing", async () => {
    const store = createLegacyStore();
    const manifestPath = path.join(store.tempDir, "malformed-manifest.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        manifestVersion: 1,
        runId: "malformed",
        targets: {},
      })}\n`,
      { mode: 0o600 },
    );

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore).toMatchObject({
      conflicts: [
        {
          archivePath: manifestPath,
          reason: "manifest is missing or unreadable",
          sourcePath: manifestPath,
        },
      ],
      restoredFiles: [],
      skippedFiles: [],
    });
  });

  it("rejects restore moves outside the manifest target archive boundary", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "restore-boundary manifest target test invariant",
    );
    const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
    const outsideArchivePath = path.join(store.tempDir, "outside-archive.jsonl");
    fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
    const unsafeMove = {
      archivePath: outsideArchivePath,
      kind: "transcript" as const,
      sourcePath: outsideSourcePath,
    };
    target.plannedMoves = [unsafeMove];
    target.completedMoves = [unsafeMove];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: manifestPath,
        reason: "manifest is missing or unreadable",
        sourcePath: manifestPath,
      },
    ]);
    expect(fs.existsSync(outsideSourcePath)).toBe(false);
    expect(fs.existsSync(outsideArchivePath)).toBe(true);
  });

  it("rejects migration sources outside the target sessions directory", () => {
    const store = createLegacyStore();
    const outsideSourcePath = path.join(store.tempDir, "outside-source.jsonl");
    const archivePath = path.join(
      path.dirname(store.sessionDir),
      "session-sqlite-import-archive",
      "outside-source.jsonl.imported-1",
    );
    fs.writeFileSync(outsideSourcePath, '{"type":"outside"}\n', { mode: 0o600 });

    expect(() =>
      assertSafeSessionSqliteMigrationMove(
        {
          archivePath,
          kind: "transcript",
          sourcePath: outsideSourcePath,
        },
        trustedMigrationTarget(store),
      ),
    ).toThrow("Migration source is outside the target sessions directory");
    expect(fs.existsSync(outsideSourcePath)).toBe(true);
  });

  it("rejects a coherently rewritten target that is not trusted by the caller", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "untrusted-target manifest target test invariant",
    );
    const outsideSessionsDir = path.join(store.tempDir, "outside-agent", "sessions");
    const outsideStorePath = path.join(outsideSessionsDir, "sessions.json");
    const outsideSourcePath = path.join(outsideSessionsDir, "outside.jsonl");
    const outsideArchiveDir = path.join(
      path.dirname(outsideSessionsDir),
      "session-sqlite-import-archive",
    );
    const outsideArchivePath = path.join(outsideArchiveDir, "outside.jsonl.imported-1");
    fs.mkdirSync(outsideArchiveDir, { recursive: true });
    fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
    const rewrittenMove = {
      archivePath: outsideArchivePath,
      kind: "transcript" as const,
      sourcePath: outsideSourcePath,
    };
    target.storePath = outsideStorePath;
    target.plannedMoves = [rewrittenMove];
    target.completedMoves = [rewrittenMove];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const restore = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });

    expect(restore.conflicts).toEqual([
      {
        archivePath: manifestPath,
        reason: "manifest does not match a trusted session target",
        sourcePath: manifestPath,
      },
    ]);
    expect(fs.existsSync(outsideSourcePath)).toBe(false);
    expect(fs.existsSync(outsideArchivePath)).toBe(true);
  });

  it("rejects recovery manifests with a rewritten SQLite path", async () => {
    const store = createLegacyStore();
    const importReport = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(importReport.migrationRun?.manifestPath);
    const manifest = readMigrationManifest(manifestPath);
    const target = expectDefined(
      manifest.targets[0],
      "rewritten-sqlite manifest target test invariant",
    );
    const outsideSqlitePath = path.join(store.tempDir, "outside.sqlite");
    manifest.failedAt = "2030-01-01T00:00:00.000Z";
    target.issues = [{ code: "startup_failure", message: "failed after archive" }];
    target.sqlitePath = outsideSqlitePath;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    const recover = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });

    expect(recover.migrationRun).toBeUndefined();
    expect(recover.targets[0]?.issues[0]?.code).toBe("recover_manifest_missing");
    expect(fs.existsSync(outsideSqlitePath)).toBe(false);
  });
});
