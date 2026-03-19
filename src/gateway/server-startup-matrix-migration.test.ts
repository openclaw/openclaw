import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { runStartupMatrixMigration } from "./server-startup-matrix-migration.js";

describe("runStartupMatrixMigration", () => {
  it("creates a snapshot before actionable startup migration", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"legacy":true}');
      const maybeCreateMatrixMigrationSnapshotMock = vi.fn(async () => ({
        created: true,
        archivePath: "/tmp/snapshot.tar.gz",
        markerPath: "/tmp/migration-snapshot.json",
      }));
      const autoMigrateLegacyMatrixStateMock = vi.fn(async () => ({
        migrated: true,
        changes: [],
        warnings: [],
      }));
      const autoPrepareLegacyMatrixCryptoMock = vi.fn(async () => ({
        migrated: false,
        changes: [],
        warnings: [],
      }));

      await runStartupMatrixMigration({
        cfg: {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        } as never,
        env: process.env,
        deps: {
          maybeCreateMatrixMigrationSnapshot: maybeCreateMatrixMigrationSnapshotMock,
          autoMigrateLegacyMatrixState: autoMigrateLegacyMatrixStateMock,
          autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock,
        },
        log: {},
      });

      expect(maybeCreateMatrixMigrationSnapshotMock).toHaveBeenCalledWith(
        expect.objectContaining({ trigger: "gateway-startup" }),
      );
      expect(autoMigrateLegacyMatrixStateMock).toHaveBeenCalledOnce();
      expect(autoPrepareLegacyMatrixCryptoMock).toHaveBeenCalledOnce();
    });
  });

  it("skips snapshot creation when startup only has warning-only migration state", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"legacy":true}');
      const maybeCreateMatrixMigrationSnapshotMock = vi.fn();
      const autoMigrateLegacyMatrixStateMock = vi.fn();
      const autoPrepareLegacyMatrixCryptoMock = vi.fn();
      const info = vi.fn();

      await runStartupMatrixMigration({
        cfg: {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
            },
          },
        } as never,
        env: process.env,
        deps: {
          maybeCreateMatrixMigrationSnapshot: maybeCreateMatrixMigrationSnapshotMock as never,
          autoMigrateLegacyMatrixState: autoMigrateLegacyMatrixStateMock as never,
          autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock as never,
        },
        log: { info },
      });

      expect(maybeCreateMatrixMigrationSnapshotMock).not.toHaveBeenCalled();
      expect(autoMigrateLegacyMatrixStateMock).not.toHaveBeenCalled();
      expect(autoPrepareLegacyMatrixCryptoMock).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        "matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet",
      );
    });
  });

  it("skips startup migration when snapshot creation fails", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"legacy":true}');
      const maybeCreateMatrixMigrationSnapshotMock = vi.fn(async () => {
        throw new Error("backup failed");
      });
      const autoMigrateLegacyMatrixStateMock = vi.fn();
      const autoPrepareLegacyMatrixCryptoMock = vi.fn();
      const warn = vi.fn();

      await runStartupMatrixMigration({
        cfg: {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        } as never,
        env: process.env,
        deps: {
          maybeCreateMatrixMigrationSnapshot: maybeCreateMatrixMigrationSnapshotMock,
          autoMigrateLegacyMatrixState: autoMigrateLegacyMatrixStateMock as never,
          autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock as never,
        },
        log: { warn },
      });

      expect(autoMigrateLegacyMatrixStateMock).not.toHaveBeenCalled();
      expect(autoPrepareLegacyMatrixCryptoMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "gateway: failed creating a Matrix migration snapshot; skipping Matrix migration for now: Error: backup failed",
      );
    });
  });

  it("downgrades migration step failures to warnings so startup can continue", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await fs.mkdir(path.join(stateDir, "matrix"), { recursive: true });
      await fs.writeFile(path.join(stateDir, "matrix", "bot-storage.json"), '{"legacy":true}');
      const maybeCreateMatrixMigrationSnapshotMock = vi.fn(async () => ({
        created: true,
        archivePath: "/tmp/snapshot.tar.gz",
        markerPath: "/tmp/migration-snapshot.json",
      }));
      const autoMigrateLegacyMatrixStateMock = vi.fn(async () => ({
        migrated: true,
        changes: [],
        warnings: [],
      }));
      const autoPrepareLegacyMatrixCryptoMock = vi.fn(async () => {
        throw new Error("disk full");
      });
      const warn = vi.fn();

      await expect(
        runStartupMatrixMigration({
          cfg: {
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "tok-123",
              },
            },
          } as never,
          env: process.env,
          deps: {
            maybeCreateMatrixMigrationSnapshot: maybeCreateMatrixMigrationSnapshotMock,
            autoMigrateLegacyMatrixState: autoMigrateLegacyMatrixStateMock,
            autoPrepareLegacyMatrixCrypto: autoPrepareLegacyMatrixCryptoMock,
          },
          log: { warn },
        }),
      ).resolves.toBeUndefined();

      expect(maybeCreateMatrixMigrationSnapshotMock).toHaveBeenCalledOnce();
      expect(autoMigrateLegacyMatrixStateMock).toHaveBeenCalledOnce();
      expect(autoPrepareLegacyMatrixCryptoMock).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        "gateway: legacy Matrix encrypted-state preparation failed during Matrix migration; continuing startup: Error: disk full",
      );
    });
  });
});
