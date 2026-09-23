import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as replaceFile from "../infra/replace-file.js";
import * as sqlitePrivateDirectory from "../infra/sqlite-private-directory.js";
import * as windowsPrivateDirectory from "../infra/windows-private-directory.js";
import {
  createSessionSqliteMigrationRun,
  writeSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
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

const { createVerifiedRecoveryStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it("retains a recreated archive while resuming an interrupted unlink", async () => {
    const { store, archivePath } = await createVerifiedRecoveryStore();
    const unlink = fs.unlinkSync;
    const spy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file).includes(".cleanup-")) {
        throw new Error("injected unlink");
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
      expect((await invoke()).status).toBe("blocked");
    } finally {
      spy.mockRestore();
    }
    fs.writeFileSync(archivePath, "replacement after interrupted cleanup");
    const resumed = await invoke();
    expect(resumed.status).toBe("blocked");
    expect(fs.readFileSync(archivePath, "utf8")).toBe("replacement after interrupted cleanup");
    expect(
      resumed.artifacts.find((item) => item.path === archivePath)?.removedBytes,
    ).toBeUndefined();
  });

  it.each(["intent", "intent-sync", "claim", "unlink", "unlink-later", "receipt"])(
    "resumes retirement after a %s failure without overclaiming removed bytes",
    async (phase) => {
      const { store, imported, archivePath } = await createVerifiedRecoveryStore();
      const manifestDir = path.dirname(
        requireMigrationManifestPath(imported.migrationRun?.manifestPath),
      );
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
              : phase === "receipt" && text.includes('"disposed"');
          if (!injected && shouldFail) {
            injected = true;
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
          ((phase === "unlink" && String(file).includes(".cleanup-")) ||
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
      const resumed = await invoke();
      expect(resumed.status).toBe("complete");
      expect(fs.existsSync(archivePath)).toBe(false);
      if (phase === "receipt") {
        expect(resumed.totals.removedBytes).toBe(0);
      }
    },
  );

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
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (!isDirectoryDescriptor(fd, path.dirname(manifestPath))) {
          return fsync(fd);
        }
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
        platformSpy.mockRestore();
        privateDirectorySpy.mockRestore();
        stagingRootSpy.mockRestore();
      }
    },
  );

  it("refuses retirement while a peer maintenance operation holds the selected state", async () => {
    const { store } = await createVerifiedRecoveryStore();
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: store.env });
    const confirm = vi.fn(async () => true);
    await withDoctorSqliteMaintenanceLock({
      env: store.env,
      operation: "fixture import",
      run: async () => {
        await expect(
          retireSessionSqliteRecovery({
            env: store.env,
            preview,
            readConfig: async () => ({}),
            confirm,
          }),
        ).rejects.toThrow("Gateway or another SQLite maintenance");
      },
    });
    expect(confirm).not.toHaveBeenCalled();
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

  it("resumes shared cross-manifest disposal after only one terminal receipt is durable", async () => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifestPath = requireMigrationManifestPath(imported.migrationRun?.manifestPath);
    const original = readMigrationManifest(manifestPath);
    const duplicate = createSessionSqliteMigrationRun(store.env, original.targets);
    duplicate.manifest.targets = structuredClone(original.targets);
    duplicate.manifest.completedAt = original.completedAt;
    writeSessionSqliteMigrationManifest(duplicate);
    const write = replaceFile.replaceFileAtomicSync;
    let injected = false;
    const spy = vi.spyOn(replaceFile, "replaceFileAtomicSync").mockImplementation((options) => {
      if (
        !injected &&
        options.filePath === manifestPath &&
        String(options.content).includes('"disposed"')
      ) {
        injected = true;
        const other = readMigrationManifest(duplicate.manifestPath);
        expect(
          other.targets[0]?.plannedMoves.find((move) => move.archivePath === archivePath)?.artifact
            ?.disposal.state,
        ).toBe("disposed");
        throw new Error("injected shared receipt");
      }
      return write(options);
    });
    const invoke = () =>
      retireSessionSqliteRecovery({
        env: store.env,
        preview: inspectSessionSqliteRecovery({ cfg: {}, env: store.env }),
        readConfig: async () => ({}),
        confirm: async () => true,
      });
    try {
      expect((await invoke()).status).toBe("blocked");
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await invoke()).status).toBe("complete");
    for (const file of [manifestPath, duplicate.manifestPath]) {
      const receipt = readMigrationManifest(file).targets[0]!.plannedMoves.find(
        (move) => move.archivePath === archivePath,
      );
      expect(receipt?.artifact?.disposal.state).toBe("disposed");
    }
  });
});
