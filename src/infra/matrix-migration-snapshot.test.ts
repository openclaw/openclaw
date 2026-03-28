import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { resolveMatrixAccountStorageRoot } from "../plugin-sdk/matrix.js";
import { detectLegacyMatrixCrypto } from "./matrix-legacy-crypto.js";

const createBackupArchiveMock = vi.hoisted(() => vi.fn());

vi.mock("./backup-create.js", () => ({
  createBackupArchive: (...args: unknown[]) => createBackupArchiveMock(...args),
}));

let hasActionableMatrixMigration: typeof import("./matrix-migration-snapshot.js").hasActionableMatrixMigration;
let maybeCreateMatrixMigrationSnapshot: typeof import("./matrix-migration-snapshot.js").maybeCreateMatrixMigrationSnapshot;
let resolveMatrixMigrationSnapshotMarkerPath: typeof import("./matrix-migration-snapshot.js").resolveMatrixMigrationSnapshotMarkerPath;
let resolveMatrixMigrationSnapshotOutputDir: typeof import("./matrix-migration-snapshot.js").resolveMatrixMigrationSnapshotOutputDir;

describe("matrix migration snapshots", () => {
  afterEach(() => {
    createBackupArchiveMock.mockReset();
  });

  beforeEach(async () => {
    vi.resetModules();
    ({
      hasActionableMatrixMigration,
      maybeCreateMatrixMigrationSnapshot,
      resolveMatrixMigrationSnapshotMarkerPath,
      resolveMatrixMigrationSnapshotOutputDir,
    } = await import("./matrix-migration-snapshot.js"));
  });

  it("creates a backup marker after writing a pre-migration snapshot", async () => {
    await withTempHome(async (home) => {
      const archivePath = path.join(home, "Backups", "openclaw-migrations", "snapshot.tar.gz");
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{}\n", "utf8");
      fs.writeFileSync(path.join(home, ".openclaw", "state.txt"), "state\n", "utf8");
      createBackupArchiveMock.mockResolvedValueOnce({
        createdAt: "2026-03-10T18:00:00.000Z",
        archivePath,
        includeWorkspace: false,
      });

      const result = await maybeCreateMatrixMigrationSnapshot({ trigger: "unit-test" });

      expect(result).toEqual({
        created: true,
        archivePath,
        markerPath: resolveMatrixMigrationSnapshotMarkerPath(process.env),
      });
      expect(createBackupArchiveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          output: resolveMatrixMigrationSnapshotOutputDir(process.env),
          includeWorkspace: false,
        }),
      );

      const marker = JSON.parse(
        fs.readFileSync(resolveMatrixMigrationSnapshotMarkerPath(process.env), "utf8"),
      ) as {
        archivePath: string;
        trigger: string;
      };
      expect(marker.archivePath).toBe(archivePath);
      expect(marker.trigger).toBe("unit-test");
    });
  });

  it("reuses an existing snapshot marker when the archive still exists", async () => {
    await withTempHome(async (home) => {
      const archivePath = path.join(home, "Backups", "openclaw-migrations", "snapshot.tar.gz");
      const markerPath = resolveMatrixMigrationSnapshotMarkerPath(process.env);
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(archivePath, "archive", "utf8");
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          version: 1,
          createdAt: "2026-03-10T18:00:00.000Z",
          archivePath,
          trigger: "older-run",
          includeWorkspace: false,
        }),
        "utf8",
      );

      const result = await maybeCreateMatrixMigrationSnapshot({ trigger: "unit-test" });

      expect(result.created).toBe(false);
      expect(result.archivePath).toBe(archivePath);
      expect(createBackupArchiveMock).not.toHaveBeenCalled();
    });
  });

  it("recreates the snapshot when the marker exists but the archive is missing", async () => {
    await withTempHome(async (home) => {
      const markerPath = resolveMatrixMigrationSnapshotMarkerPath(process.env);
      const replacementArchivePath = path.join(
        home,
        "Backups",
        "openclaw-migrations",
        "replacement.tar.gz",
      );
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.mkdirSync(path.dirname(replacementArchivePath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          version: 1,
          createdAt: "2026-03-10T18:00:00.000Z",
          archivePath: path.join(home, "Backups", "openclaw-migrations", "missing.tar.gz"),
          trigger: "older-run",
          includeWorkspace: false,
        }),
        "utf8",
      );
      createBackupArchiveMock.mockResolvedValueOnce({
        createdAt: "2026-03-10T19:00:00.000Z",
        archivePath: replacementArchivePath,
        includeWorkspace: false,
      });

      const result = await maybeCreateMatrixMigrationSnapshot({ trigger: "unit-test" });

      expect(result.created).toBe(true);
      expect(result.archivePath).toBe(replacementArchivePath);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { archivePath: string };
      expect(marker.archivePath).toBe(replacementArchivePath);
    });
  });

  it("surfaces backup creation failures without writing a marker", async () => {
    await withTempHome(async () => {
      createBackupArchiveMock.mockRejectedValueOnce(new Error("backup failed"));

      await expect(maybeCreateMatrixMigrationSnapshot({ trigger: "unit-test" })).rejects.toThrow(
        "backup failed",
      );
      expect(fs.existsSync(resolveMatrixMigrationSnapshotMarkerPath(process.env))).toBe(false);
    });
  });

  it("does not treat warning-only Matrix migration as actionable", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      fs.mkdirSync(path.join(stateDir, "matrix", "crypto"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "matrix", "bot-storage.json"),
        '{"legacy":true}',
        "utf8",
      );
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
            },
          },
        }),
        "utf8",
      );

      expect(
        hasActionableMatrixMigration({
          cfg: {
            channels: {
              matrix: {
                homeserver: "https://matrix.example.org",
              },
            },
          } as never,
          env: process.env,
        }),
      ).toBe(false);
    });
  });

  it("treats resolvable Matrix legacy state as actionable", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      fs.mkdirSync(path.join(stateDir, "matrix"), { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "matrix", "bot-storage.json"),
        '{"legacy":true}',
        "utf8",
      );

      expect(
        hasActionableMatrixMigration({
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
        }),
      ).toBe(true);
    });
  });

  it("treats legacy Matrix crypto as warning-only until the plugin helper is available", async () => {
    await withTempHome(
      async (home) => {
        const stateDir = path.join(home, ".openclaw");
        fs.mkdirSync(path.join(home, "empty-bundled"), { recursive: true });
        const { rootDir } = resolveMatrixAccountStorageRoot({
          stateDir,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
        });
        fs.mkdirSync(path.join(rootDir, "crypto"), { recursive: true });
        fs.writeFileSync(
          path.join(rootDir, "crypto", "bot-sdk.json"),
          JSON.stringify({ deviceId: "DEVICE123" }),
          "utf8",
        );

        const cfg = {
          channels: {
            matrix: {
              homeserver: "https://matrix.example.org",
              userId: "@bot:example.org",
              accessToken: "tok-123",
            },
          },
        } as never;

        const detection = detectLegacyMatrixCrypto({
          cfg,
          env: process.env,
        });
        expect(detection.plans).toHaveLength(1);
        expect(detection.warnings).toContain(
          "Legacy Matrix encrypted state was detected, but the Matrix plugin helper is unavailable. Install or repair @openclaw/matrix so OpenClaw can inspect the old rust crypto store before upgrading.",
        );
        expect(
          hasActionableMatrixMigration({
            cfg,
            env: process.env,
          }),
        ).toBe(false);
      },
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: (home) => path.join(home, "empty-bundled"),
        },
      },
    );
  });
});
