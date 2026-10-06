import fs from "node:fs";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import * as sqlitePrivateDirectory from "../infra/sqlite-private-directory.js";
import * as windowsPrivateDirectory from "../infra/windows-private-directory.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  isDirectoryDescriptor,
  readMigrationManifest,
  requireMigrationManifestPath,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

const { createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([
    "intent",
    "intent-sync",
    "claim",
    "unlink",
    "unlink-later",
    "receipt",
    "recreated",
    "shared-receipt",
  ])("resumes retirement after a %s failure without overclaiming removed bytes", async (phase) => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const manifestDir = path.dirname(manifestPath);
    const duplicate =
      phase === "shared-receipt" ? createSessionSqliteMigrationRun(store.env, []) : undefined;
    if (duplicate) {
      const manifest = readMigrationManifest(manifestPath);
      duplicate.manifest.targets = structuredClone(manifest.targets);
      duplicate.manifest.completedAt = manifest.completedAt;
      writeSessionSqliteMigrationManifest(duplicate);
    }
    const original = fs.readFileSync(archivePath);
    let injected = false;
    let claimUnlinks = 0;
    const write = replaceFile.replaceFileAtomicSync;
    const unlink = fs.unlinkSync;
    const fsync = fs.fsyncSync;
    const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!injected && phase === "intent-sync" && isDirectoryDescriptor(fd, manifestDir)) {
        injected = true;
        throw new Error("injected intent-sync");
      }
      fsync(fd);
    });
    const writeSpy = vi
      .spyOn(replaceFile, "replaceFileAtomicSync")
      .mockImplementation((options) => {
        const text = String(options.content);
        const shouldFail =
          phase === "intent"
            ? text.includes('"pending-disposal"')
            : (phase === "receipt" || (duplicate && options.filePath === manifestPath)) &&
              text.includes('"disposed"');
        if (!injected && shouldFail) {
          injected = true;
          if (duplicate) {
            expect(
              readMigrationManifest(duplicate.manifestPath).targets[0]?.plannedMoves.find(
                (move) => move.archivePath === archivePath,
              )?.artifact?.disposal.state,
            ).toBe("disposed");
          }
          throw new Error(`injected ${phase}`);
        }
        return write(options);
      });
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).includes(".cleanup-")) {
        claimUnlinks += 1;
      }
      if (
        !injected &&
        (((phase === "unlink" || phase === "recreated") && String(file).includes(".cleanup-")) ||
          (phase === "unlink-later" && claimUnlinks === 2) ||
          (phase === "claim" && String(file) === archivePath))
      ) {
        injected = true;
        throw new Error(`injected ${phase}`);
      }
      return unlink(file);
    });
    const invoke = () =>
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
    try {
      if (phase === "intent" || phase === "intent-sync") {
        await expect(invoke()).rejects.toThrow(`injected ${phase}`);
        expect(fs.readFileSync(archivePath)).toEqual(original);
      } else {
        const first = await invoke();
        expect(first.status).toBe("blocked");
        if (phase === "unlink-later") {
          expect(first.totals.removedFiles).toBe(1);
        }
        if (phase === "receipt") {
          expect(first.artifacts.find((item) => item.path === archivePath)?.removedBytes).toBe(
            original.length,
          );
        }
      }
    } finally {
      writeSpy.mockRestore();
      unlinkSpy.mockRestore();
      syncSpy.mockRestore();
    }
    expect(injected).toBe(true);
    if (phase === "recreated") {
      fs.writeFileSync(archivePath, "replacement after interrupted cleanup");
    }
    const resumed = await invoke();
    if (phase === "recreated") {
      expect(resumed.status).toBe("blocked");
      expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement after interrupted cleanup");
      expect(
        resumed.artifacts.find((item) => item.path === archivePath)?.removedBytes,
      ).toBeUndefined();
      return;
    }
    expect(resumed.status).toBe("complete");
    if (duplicate) {
      for (const file of [manifestPath, duplicate.manifestPath]) {
        expect(
          readMigrationManifest(file).targets[0]!.plannedMoves.find(
            (move) => move.archivePath === archivePath,
          )?.artifact?.disposal.state,
        ).toBe("disposed");
      }
    }
    expect(fs.existsSync(archivePath)).toBe(false);
    if (phase === "receipt") {
      expect(resumed.totals.removedBytes).toBe(0);
    }
  });

  it.each([
    { platform: "win32", syncFailure: "unsupported", retires: true },
    { platform: "linux", syncFailure: "unsupported", retires: false },
    { platform: "win32", syncFailure: "EIO", retires: false },
  ] as const)(
    "applies the manifest directory-sync policy for $platform $syncFailure",
    async ({ platform, syncFailure, retires }) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore();
      const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
      const original = fs.readFileSync(archivePath);
      const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
      const fsync = fs.fsyncSync;
      const failureCode =
        syncFailure === "EIO" ? "EIO" : platform === "win32" ? "EPERM" : "ENOTSUP";
      // Simulate directory-sync policy without invoking foreign-platform ACL APIs.
      const stagingRootSpy = vi
        .spyOn(sqlitePrivateDirectory, "resolvePrivateSqliteSnapshotStagingRoot")
        .mockReturnValue(store.tempDir);
      const privateDirectorySpy = vi
        .spyOn(windowsPrivateDirectory, "createPrivateWindowsDirectory")
        .mockImplementation((directoryPath) => {
          fs.mkdirSync(directoryPath, { mode: 0o700 });
        });
      const installPlatformSpy = () =>
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      let platformSpy: ReturnType<typeof installPlatformSpy> | undefined;
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (!isDirectoryDescriptor(fd, path.dirname(manifestPath))) {
          return fsync(fd);
        }
        platformSpy ??= installPlatformSpy();
        // Assert the persisted intent at the commit boundary, before any original moves.
        const manifest = readMigrationManifest(manifestPath);
        if (fs.existsSync(archivePath)) {
          expect(
            manifest.targets[0]?.completedMoves.find((move) => move.archivePath === archivePath)
              ?.artifact?.disposal.state,
          ).toBe("pending-disposal");
          expect(fs.readFileSync(archivePath)).toEqual(original);
        }
        throw Object.assign(new Error(`injected manifest ${failureCode}`), { code: failureCode });
      });
      try {
        const cleanup = retireSessionSqliteRecovery({
          env: store.env,
          preview,
          readConfig: async () => ({}),
          confirm: async () => true,
        });
        if (retires) {
          const result = await cleanup;
          expect(result.status).toBe("complete");
          expect(result.artifacts.find((item) => item.path === archivePath)).toMatchObject({
            outcome: "removed",
            removedBytes: original.length,
          });
          expect(fs.existsSync(archivePath)).toBe(false);
          expect(
            readMigrationManifest(manifestPath).targets[0]?.completedMoves.find(
              (move) => move.archivePath === archivePath,
            )?.artifact?.disposal.state,
          ).toBe("disposed");
        } else {
          await expect(cleanup).rejects.toThrow(`injected manifest ${failureCode}`);
          expect(fs.readFileSync(archivePath)).toEqual(original);
        }
      } finally {
        syncSpy.mockRestore();
        platformSpy?.mockRestore();
        privateDirectorySpy.mockRestore();
        stagingRootSpy.mockRestore();
      }
    },
  );

  it("refuses retirement while a peer maintenance operation holds the selected state", async () => {
    const { store, archivePath } = await createVerifiedRecoveryStore();
    const original = fs.readFileSync(archivePath);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    const confirm = vi.fn(async () => true);
    await withDoctorSqliteMaintenanceLock({
      env: store.env,
      operation: "fixture import",
      run: async () => {
        await expect(
          runOutsideOpenClawDatabaseMaintenanceScope(() =>
            retireSessionSqliteRecovery({
              env: store.env,
              preview,
              readConfig: async () => ({}),
              confirm,
            }),
          ),
        ).rejects.toThrow("undergoing offline maintenance");
      },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(archivePath)).toEqual(original);
  });

  it("protects originals already consumed by restore without reporting unexplained loss", async () => {
    const { store, archivePath } = await createVerifiedRecoveryStore();
    const restored = await runDoctorSessionSqlite({
      env: store.env,
      mode: "restore",
      store: store.storePath,
    });
    expect(restored.targets[0]?.restore?.restoredFiles).toContain(store.transcriptPath);
    const original = fs.readFileSync(store.transcriptPath);
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    expect(preview.artifacts.find((item) => item.path === archivePath)).toMatchObject({
      outcome: "protected",
      reason: "archive-consumed-by-restore",
    });
    const cleanup = await retireSessionSqliteRecovery({
      env: store.env,
      preview,
      readConfig: async () => ({}),
      confirm: async () => true,
    });
    expect(cleanup.status).toBe("complete");
    expect(cleanup.totals.removedFiles).toBe(0);
    expect(fs.readFileSync(store.transcriptPath)).toEqual(original);
  });
});
