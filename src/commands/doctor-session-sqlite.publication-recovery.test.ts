import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as directoryDurability from "../infra/directory-durability.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import * as migrationArtifact from "./doctor-session-sqlite-artifact.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  runPublicSessionSqlite,
  importLegacyStore,
  readMigrationManifest,
  requireMigrationManifestPath,
  canonicalTestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { doctorCommand } from "./doctor.js";

const { createHistoricalRestoreStore, createVerifiedRecoveryStore } =
  useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([
    { kind: "transcript", mode: "import", entry: "inner" },
    { kind: "legacy-store", mode: "import", entry: "inner" },
    { kind: "transcript", mode: "restore", entry: "inner" },
    { kind: "legacy-store", mode: "restore", entry: "inner" },
    { kind: "transcript", mode: "import", entry: "public" },
    { kind: "legacy-store", mode: "import", entry: "public" },
    { kind: "transcript", mode: "restore", entry: "public" },
    { kind: "legacy-store", mode: "restore", entry: "public" },
  ] as const)(
    "recovers interrupted $kind publication through $entry $mode",
    async ({ kind, mode, entry }) => {
      const { store } = await createVerifiedRecoveryStore();
      await runDoctorSessionSqlite({ env: store.env, mode: "restore", store: store.storePath });
      const source = kind === "transcript" ? store.transcriptPath : store.storePath;
      const original = fs.readFileSync(source);
      const token = "sk-abcdefghijklmnopqrstuv";
      const unlink = fs.unlinkSync;
      let injected = false;
      const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (!injected && file === source) {
          injected = true;
          throw new Error(
            `injected interruption before source unlink: Authorization: Bearer ${token}`,
          );
        }
        return unlink(file);
      });
      let interrupted;
      try {
        interrupted = await importLegacyStore(store);
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      const manifestPath = requireMigrationManifestPath(interrupted.migrationRun?.manifestPath);
      const move = readMigrationManifest(manifestPath).targets[0]!.plannedMoves.find(
        (item) => item.sourcePath === source,
      )!;
      const issueCode =
        kind === "transcript" ? "transcript_archive_failed" : "legacy_store_archive_failed";
      const issue = interrupted.targets[0]?.issues.find((item) => item.code === issueCode);
      expect(issue?.message).toContain("injected interruption before source unlink");
      expect(issue?.message).not.toContain(token);
      expect(fs.readFileSync(source)).toEqual(original);
      expect(fs.statSync(source).nlink).toBe(2);
      expect(fs.statSync(source).ino).toBe(fs.statSync(move.archivePath).ino);
      if (entry === "public") {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toMatchObject({ code: 0 });
      } else {
        const recovered = await runDoctorSessionSqlite({
          env: store.env,
          mode,
          store: store.storePath,
        });
        expect(recovered.targets[0]?.issues).toEqual([]);
      }
      expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toContain(
        move.archivePath,
      );
      expect(fs.existsSync(move.archivePath)).toBe(false);
      if (mode === "restore") {
        expect(fs.statSync(source).nlink).toBe(1);
        expect(fs.readFileSync(source)).toEqual(original);
        const reimport = await importLegacyStore(store);
        expect(reimport.targets[0]?.issues).toEqual([]);
      }
      closeOpenClawAgentDatabasesForTest();
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.status).toBe("complete");
      expect(cleanup.totals.removedFiles).toBe(2);
    },
  );

  it.each(["mismatch", "third-link"] as const)(
    "refuses public recovery of a recorded publication with %s",
    async (fault) => {
      const { store, imported } = await createVerifiedRecoveryStore();
      const manifest = readMigrationManifest(imported.migrationRun?.manifestPath);
      const move = manifest.targets[0]!.plannedMoves.find((item) => item.kind === "legacy-store")!;
      fs.linkSync(move.archivePath, move.sourcePath);
      const third = path.join(store.sessionDir, "unexpected-alias");
      if (fault === "third-link") {
        fs.linkSync(move.sourcePath, third);
      } else {
        fs.writeFileSync(move.sourcePath, "different bytes on the same inode");
      }
      const before = fs.readFileSync(move.sourcePath);
      for (const mode of ["import", "restore"] as const) {
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn((code: number): never => {
            throw new ExitError(code);
          }),
        };
        await expect(
          doctorCommand(runtime, {
            sessionSqlite: mode,
            sessionSqliteStore: store.storePath,
            json: true,
          }),
        ).rejects.toThrow(/hard-linked|publication paths changed/);
        expect(fs.readFileSync(move.sourcePath)).toEqual(before);
        expect(fs.readFileSync(move.archivePath)).toEqual(before);
        expect(fs.statSync(move.sourcePath).nlink).toBe(fault === "third-link" ? 3 : 2);
      }
    },
  );

  it.each([1, 2] as const)(
    "protects historical v%s restore metadata and its retained transcript dependency from cleanup",
    async (version) => {
      const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical cleanup target");
      const index = expectDefined(
        target.plannedMoves.find((move) => move.kind === "legacy-store"),
        "historical index",
      );
      const indexIdentity = migrationArtifact.readMigrationArtifactIdentity(index.archivePath);
      const indexBytes = fs.readFileSync(index.archivePath);
      const transcriptBytes = fs.readFileSync(archivePath);
      fs.writeFileSync(store.transcriptPath, "new source history\n", { mode: 0o600 });
      const publish = directoryDurability.publishFileExclusive;
      const publicationSpy = vi
        .spyOn(directoryDurability, "publishFileExclusive")
        .mockImplementation(async (options) => {
          if (options.sourcePath === index.archivePath && options.targetPath === index.sourcePath) {
            throw Object.assign(new Error("injected unsupported hard link"), { code: "EXDEV" });
          }
          return publish(options);
        });
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const asyncCopySpy = vi.spyOn(fsPromises, "copyFile");
      try {
        const failed = await runPublicSessionSqlite(store, "restore");
        expect(failed.exitCode).toBe(1);
        expect(failed.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([expect.objectContaining({ archivePath: index.archivePath })]),
        );
        expect(publicationSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sourcePath: index.archivePath,
            targetPath: index.sourcePath,
            strategy: "link-required",
          }),
        );
        expect(copySpy).not.toHaveBeenCalled();
        expect(asyncCopySpy).not.toHaveBeenCalled();
      } finally {
        publicationSpy.mockRestore();
        copySpy.mockRestore();
        asyncCopySpy.mockRestore();
      }
      const recorded = readMigrationManifest(manifestPath);
      expect(recorded.manifestVersion).toBe(version);
      const indexMoves = [
        ...recorded.targets[0]!.plannedMoves,
        ...recorded.targets[0]!.completedMoves,
      ].filter((move) => move.archivePath === index.archivePath);
      expect(indexMoves).toHaveLength(2);
      for (const move of indexMoves) {
        expect(move.artifact).toMatchObject({
          classification: "protected",
          disposal: { state: "retained" },
          identity: indexIdentity,
          dependencies: [canonicalTestPath(store.transcriptPath)],
        });
      }
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      expect(preview.artifacts.find((item) => item.path === index.archivePath)?.outcome).toBe(
        "protected",
      );
      expect(preview.artifacts.find((item) => item.path === archivePath)).toMatchObject({
        outcome: "protected",
        reason: "retained-recovery-dependency",
      });
      const cleanup = await retireSessionSqliteRecovery({
        env: store.env,
        preview,
        readConfig: async () => ({}),
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(0);
      expect(fs.readFileSync(index.archivePath)).toEqual(indexBytes);
      expect(fs.readFileSync(archivePath)).toEqual(transcriptBytes);
      expect(fs.readFileSync(store.transcriptPath, "utf8")).toBe("new source history\n");
      expect(fs.existsSync(index.sourcePath)).toBe(false);
      expect(fs.existsSync(target.sqlitePath)).toBe(false);
    },
  );
});
