import fs from "node:fs";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import {
  readMigrationArtifactIdentity,
  statMigrationPath,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  assertSafeSessionSqliteMigrationMove,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
} from "../infra/session-sqlite-migration-manifest.js";
import { planSessionJsonlArchiveMove } from "./doctor-session-sqlite-archive.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import { restoreSessionSqliteMigrationRun } from "./doctor-session-sqlite-restore.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
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
  const report = await importLegacyStore(store);
  const manifestPath = requireMigrationManifestPath(report.migrationRun?.manifestPath);
  const manifest = readMigrationManifest(manifestPath);
  const target = expectDefined(manifest.targets[0], "manifest target");
  return { store, manifestPath, manifest, target };
}

describe("runDoctorSessionSqlite", () => {
  it("archives long Matrix thread keys with bounded names and restores their original bytes", async () => {
    const store = createLegacyStore({ transcriptLines: RECOVERY_TRANSCRIPT_LINES });
    const sessionKey = `agent:main:matrix:channel:${"room".repeat(32)}:thread:${"event".repeat(32)}`;
    const transcriptPath = path.join(store.sessionDir, `${"session".repeat(24)}-é.jsonl`);
    const trajectoryPath = transcriptPath.replace(/\.jsonl$/, ".trajectory.jsonl");
    fs.renameSync(store.transcriptPath, transcriptPath);
    fs.renameSync(store.trajectoryPath, trajectoryPath);
    fs.writeFileSync(
      store.storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: "session-1", updatedAt: 2000, sessionFile: transcriptPath },
      }),
    );
    const originals = new Map(
      [transcriptPath, trajectoryPath, store.storePath].map((file) => [
        canonicalTestPath(file),
        fs.readFileSync(file, "utf8"),
      ]),
    );

    const imported = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const target = expectDefined(readMigrationManifest(manifestPath).targets[0], "manifest target");

    expect(imported.targets[0]?.issues).toEqual([]);
    for (const [sourcePath, bytes] of originals) {
      const move = expectDefined(
        target.completedMoves.find((candidate) => candidate.sourcePath === sourcePath),
        "archived original",
      );
      expect(Buffer.byteLength(path.basename(move.archivePath), "utf8")).toBeLessThanOrEqual(255);
      expect(fs.readFileSync(move.archivePath, "utf8")).toBe(bytes);
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
    const restored = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });
    expect(restored.conflicts).toEqual([]);
    for (const [file, bytes] of originals) {
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
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
      archivePath: path.join(
        path.dirname(path.dirname(sourcePath)),
        "session-sqlite-import-archive",
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
    fs.writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const receiptBytes = fs.readFileSync(receiptPath, "utf8");
    expect(readSessionSqliteMigrationManifest(receiptPath)?.targets[0]?.plannedMoves).toHaveLength(
      1,
    );
    expect(collectRecoveryInventory({ cfg: {}, env: store.env }).report.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: move.archivePath,
          outcome: "protected",
          reason: "incomplete-recovery-operation",
        }),
      ]),
    );

    expect(
      (await runDoctorSessionSqlite({ env: store.env, mode: "dry-run", store: store.storePath }))
        .totals.issues,
    ).toBe(0);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
    const imported = await importLegacyStore(store);
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const target = expectDefined(readMigrationManifest(manifestPath).targets[0], "manifest target");
    expect(imported.targets[0]?.issues).toEqual([]);
    const archived = expectDefined(
      target.completedMoves.find((candidate) => candidate.sourcePath === sourcePath),
      "archived transcript",
    );
    expect(fs.readFileSync(archived.archivePath, "utf8")).toBe(original);
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(receiptBytes);
    expect(
      (await runDoctorSessionSqlite({ env: store.env, mode: "dry-run", store: store.storePath }))
        .totals.issues,
    ).toBe(0);
    const restored = await restoreSessionSqliteMigrationRun({
      manifestPath,
      trustedTargets: [trustedMigrationTarget(store)],
    });
    expect(restored.conflicts).toEqual([]);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
  });

  it("keeps bounded hash identity and collision suffixes for long archive names", () => {
    const store = createLegacyStore();
    const sourcePathRaw = path.join(store.sessionDir, `${"session".repeat(24)}-é.jsonl`);
    fs.writeFileSync(sourcePathRaw, "preserved");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1788844747943);
    try {
      const params = {
        archiveKey: "key".repeat(60),
        kind: "transcript" as const,
        sourcePathRaw,
        target: trustedMigrationTarget(store),
      };
      const first = planSessionJsonlArchiveMove(params);
      expect(planSessionJsonlArchiveMove(params).archivePath).toBe(first.archivePath);
      const other = planSessionJsonlArchiveMove({
        ...params,
        archiveKey: params.archiveKey + "other",
      });
      expect(other.archivePath).not.toBe(first.archivePath);
      fs.writeFileSync(first.archivePath, "occupied");
      const second = planSessionJsonlArchiveMove(params);
      expect(second.archivePath).toMatch(/\.imported-1788844747943\.1$/);
      const third = planSessionJsonlArchiveMove({
        ...params,
        reservedArchivePaths: new Set([second.archivePath]),
      });
      expect(third.archivePath).toMatch(/\.imported-1788844747943\.2$/);
      for (const move of [first, other, second, third]) {
        expect(Buffer.byteLength(path.basename(move.archivePath), "utf8")).toBeLessThanOrEqual(255);
      }
      expect(fs.readFileSync(first.archivePath, "utf8")).toBe("occupied");
      expect(fs.readFileSync(sourcePathRaw, "utf8")).toBe("preserved");
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves bigint stats and does not hide permission failures in optional migration lookups", () => {
    const store = createLegacyStore();
    expect(typeof statMigrationPath(store.transcriptPath, { bigint: true })?.ino).toBe("bigint");
    expect(typeof statMigrationPath(store.transcriptPath)?.ino).toBe("number");
    expect(statMigrationPath(path.join(store.sessionDir, "absent"))).toBeUndefined();
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
      throw denied;
    });
    try {
      expect(() => statMigrationPath(store.transcriptPath)).toThrow(denied);
      expect(() => statMigrationPath(store.transcriptPath, { bigint: true })).toThrow(denied);
    } finally {
      stat.mockRestore();
    }
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

  it.each(["outside archive", "untrusted target"] as const)(
    "rejects a restore manifest with %s",
    async (fault) => {
      const imported = await createImportedManifest();
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

describe("pre-artifact session migration receipts", () => {
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
      const scope = {
        agentId: "main",
        env: store.env,
        storePath: store.storePath,
        sessionKey: "agent:main:main",
      };
      if (existing) {
        await upsertSessionEntryCore(scope, {
          sessionId: "session-1",
          updatedAt: 3000,
          label: "Current SQLite metadata",
        });
      }
      const currentIndex = fs.readFileSync(store.storePath, "utf8");
      const archivePath = path.join(
        path.dirname(store.sessionDir),
        "session-sqlite-import-archive",
        "sessions.json.legacy.1785542400000",
      );
      const archivedIndex =
        archive === "identical"
          ? currentIndex
          : JSON.stringify({
              "agent:main:old": { sessionId: "older-session", updatedAt: 1 },
            });
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
      expect(readMigrationManifest(imported.migrationRun?.manifestPath).completedAt).toBeDefined();
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: "session-1",
        label: existing && archive !== "different" ? "Current SQLite metadata" : "Legacy metadata",
      });
      const currentArchive = expectDefined(
        imported.targets[0]?.archivedLegacyStoreFiles?.[0],
        "verified current index archive",
      );
      expect(currentArchive).not.toBe(archivePath);
      expect(fs.readFileSync(currentArchive, "utf8")).toBe(currentIndex);
      if (archive !== "missing") {
        expect(fs.readFileSync(archivePath, "utf8")).toBe(archivedIndex);
      } else {
        expect(fs.existsSync(archivePath)).toBe(false);
      }
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(receiptBytes);
      expect(() => assertSessionStoreMigrationComplete({ cfg: {}, env: store.env })).not.toThrow();
    },
  );
});
