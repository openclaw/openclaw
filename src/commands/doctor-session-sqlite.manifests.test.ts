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

async function createImportedManifest() {
  const store = createLegacyStore();
  const report = await importLegacyStore(store);
  const manifestPath = requireMigrationManifestPath(report.migrationRun?.manifestPath);
  const manifest = readMigrationManifest(manifestPath);
  const target = expectDefined(manifest.targets[0], "manifest target");
  return { store, manifestPath, manifest, target };
}

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

  it("checkpoints bulk archive moves without per-file manifest rewrites", async () => {
    const store = createLegacyStore();
    const pointerPath = path.join(store.sessionDir, "session-1.trajectory-path.json");
    fs.writeFileSync(
      pointerPath,
      JSON.stringify({
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: store.trajectoryPath,
      }),
      { mode: 0o600 },
    );
    const expectedPointerPath = canonicalTestPath(pointerPath);
    const expectedStorePath = fs.realpathSync.native(store.storePath);
    const expectedSources = [
      "orphan.jsonl",
      "session-1.jsonl",
      "session-1.trajectory.jsonl",
      "session-1.trajectory-path.json",
      "sessions.json",
      "orphan collision.jsonl",
      "orphan_collision.jsonl",
    ];
    const sessions = JSON.parse(fs.readFileSync(store.storePath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    for (let index = 0; index < 64; index += 1) {
      const sessionId = `bulk-session-${index}`;
      const sessionFile = `${sessionId}.jsonl`;
      expectedSources.push(sessionFile, `orphan-${index}.jsonl`);
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
      const target = expectDefined(manifest.targets[0], "manifest target");
      const manifestWrites = replaceFileAtomicSync.mock.calls.filter(([options]) =>
        options.filePath.includes("session-sqlite-migration-runs"),
      ).length;
      const plannedUnreferencedMoves = target.plannedMoves.filter(
        (move) => move.kind === "unreferenced-jsonl",
      );

      expect(report.migrationRun?.runId).toBe(manifest.runId);
      expect(manifest.manifestVersion).toBe(3);
      expect(target).toMatchObject({
        agentId: "main",
        storePath: expectedStorePath,
        validationBeforeArchive: "passed",
      });
      expect(target.plannedMoves.map((move) => path.basename(move.sourcePath)).toSorted()).toEqual(
        expectedSources.toSorted(),
      );
      expect(target.completedMoves).toHaveLength(135);
      expect(plannedUnreferencedMoves).toHaveLength(67);
      expect(new Set(plannedUnreferencedMoves.map((move) => move.archivePath)).size).toBe(67);
      expect(target.plannedMoves.filter((move) => move.kind === "transcript")).toHaveLength(65);
      expect(
        target.completedMoves.filter((move) => move.kind === "unreferenced-jsonl"),
      ).toHaveLength(67);
      expect(target.completedMoves.filter((move) => move.kind === "transcript")).toHaveLength(65);
      expect(manifestWrites).toBeLessThan(20);
      expect(replaceFileAtomicSync).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: report.migrationRun?.manifestPath,
          mode: 0o600,
          tempPrefix: path.basename(report.migrationRun?.manifestPath ?? ""),
        }),
      );
      expect(fs.existsSync(pointerPath)).toBe(false);
      expect(report.targets[0]?.archivedTranscriptFiles.map((file) => path.basename(file))).toEqual(
        expect.arrayContaining([
          expect.stringContaining("session-1.trajectory-path.json.imported-"),
        ]),
      );
      expect(target.plannedMoves).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "trajectory", sourcePath: expectedPointerPath }),
        ]),
      );
    } finally {
      replaceFileAtomicSync.mockRestore();
    }
  });

  it.each(["malformed", "outside archive", "untrusted target"] as const)(
    "rejects a restore manifest with %s",
    async (fault) => {
      const imported = fault === "malformed" ? undefined : await createImportedManifest();
      const store = imported?.store ?? createLegacyStore();
      const manifestPath =
        imported?.manifestPath ?? path.join(store.tempDir, "malformed-manifest.json");
      const outsideSessionsDir = path.join(store.tempDir, "outside-agent", "sessions");
      const outsideSourcePath =
        fault === "untrusted target"
          ? path.join(outsideSessionsDir, "outside.jsonl")
          : path.join(store.tempDir, "outside-source.jsonl");
      const outsideArchivePath =
        fault === "untrusted target"
          ? path.join(
              path.dirname(outsideSessionsDir),
              "session-sqlite-import-archive",
              "outside.jsonl.imported-1",
            )
          : path.join(store.tempDir, "outside-archive.jsonl");
      if (imported) {
        const { target, manifest } = imported;
        fs.mkdirSync(path.dirname(outsideArchivePath), { recursive: true });
        fs.writeFileSync(outsideArchivePath, '{"type":"outside"}\n', { mode: 0o600 });
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
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      } else {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ manifestVersion: 1, runId: "malformed", targets: {} }),
          { mode: 0o600 },
        );
      }
      const restore = await restoreSessionSqliteMigrationRun({
        manifestPath,
        trustedTargets: [trustedMigrationTarget(store)],
      });
      expect(restore.conflicts).toEqual([
        {
          archivePath: manifestPath,
          sourcePath: manifestPath,
          reason:
            fault === "untrusted target"
              ? "manifest does not match a trusted session target"
              : "manifest is missing or unreadable",
        },
      ]);
      expect(restore.restoredFiles).toEqual([]);
      expect(restore.skippedFiles).toEqual([]);
      if (imported) {
        expect(fs.existsSync(outsideSourcePath)).toBe(false);
        expect(fs.existsSync(outsideArchivePath)).toBe(true);
      }
    },
  );

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

  it("rejects recovery manifests with a rewritten SQLite path", async () => {
    const { store, manifestPath, manifest, target } = await createImportedManifest();
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
