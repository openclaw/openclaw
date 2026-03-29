import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMatrixDoctorRepair,
  cleanStaleMatrixPluginConfig,
  collectMatrixInstallPathWarnings,
  formatMatrixLegacyCryptoPreview,
  formatMatrixLegacyStatePreview,
  runMatrixDoctorSequence,
} from "./matrix.js";

vi.mock("../../../infra/matrix-migration-snapshot.js", () => ({
  hasActionableMatrixMigration: vi.fn(() => false),
  hasPendingMatrixMigration: vi.fn(() => false),
  maybeCreateMatrixMigrationSnapshot: vi.fn(),
}));

vi.mock("../../../infra/matrix-legacy-state.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/matrix-legacy-state.js")>(
    "../../../infra/matrix-legacy-state.js",
  );
  return {
    ...actual,
    autoMigrateLegacyMatrixState: vi.fn(async () => ({ changes: [], warnings: [] })),
  };
});

vi.mock("../../../infra/matrix-legacy-crypto.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/matrix-legacy-crypto.js")>(
    "../../../infra/matrix-legacy-crypto.js",
  );
  return {
    ...actual,
    autoPrepareLegacyMatrixCrypto: vi.fn(async () => ({ changes: [], warnings: [] })),
  };
});

describe("doctor matrix provider helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats the legacy state preview", () => {
    const preview = formatMatrixLegacyStatePreview({
      accountId: "default",
      legacyStoragePath: "/tmp/legacy-sync.json",
      targetStoragePath: "/tmp/new-sync.json",
      legacyCryptoPath: "/tmp/legacy-crypto.json",
      targetCryptoPath: "/tmp/new-crypto.json",
      selectionNote: "Picked the newest account.",
      targetRootDir: "/tmp/account-root",
    });

    expect(preview).toContain("Matrix plugin upgraded in place.");
    expect(preview).toContain("/tmp/legacy-sync.json -> /tmp/new-sync.json");
    expect(preview).toContain("Picked the newest account.");
  });

  it("formats encrypted-state migration previews", () => {
    const previews = formatMatrixLegacyCryptoPreview({
      warnings: ["matrix warning"],
      plans: [
        {
          accountId: "default",
          rootDir: "/tmp/account-root",
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "tok-123",
          deviceId: "DEVICE123",
          legacyCryptoPath: "/tmp/legacy-crypto.json",
          recoveryKeyPath: "/tmp/recovery-key.txt",
          statePath: "/tmp/state.json",
        },
      ],
    });

    expect(previews[0]).toBe("- matrix warning");
    expect(previews[1]).toContain(
      'Matrix encrypted-state migration is pending for account "default".',
    );
    expect(previews[1]).toContain("/tmp/recovery-key.txt");
  });

  it("warns on stale custom Matrix plugin paths", async () => {
    const missingPath = path.join(tmpdir(), "openclaw-matrix-missing-provider-test");
    await fs.rm(missingPath, { recursive: true, force: true });

    const warnings = await collectMatrixInstallPathWarnings({
      plugins: {
        installs: {
          matrix: {
            source: "path",
            sourcePath: missingPath,
            installPath: missingPath,
          },
        },
      },
    });

    expect(warnings[0]).toContain("custom path that no longer exists");
    expect(warnings[0]).toContain(missingPath);
    expect(warnings[1]).toContain("openclaw plugins install @openclaw/matrix");
    expect(warnings[2]).toContain("openclaw plugins install ");
    expect(warnings[2]).toContain(path.join("extensions", "matrix"));
  });

  it("summarizes matrix repair messaging", async () => {
    const matrixSnapshotModule = await import("../../../infra/matrix-migration-snapshot.js");
    const matrixStateModule = await import("../../../infra/matrix-legacy-state.js");
    const matrixCryptoModule = await import("../../../infra/matrix-legacy-crypto.js");

    vi.mocked(matrixSnapshotModule.hasActionableMatrixMigration).mockReturnValue(true);
    vi.mocked(matrixSnapshotModule.maybeCreateMatrixMigrationSnapshot).mockResolvedValue({
      archivePath: "/tmp/matrix-backup.tgz",
      created: true,
      markerPath: "/tmp/marker.json",
    });
    vi.mocked(matrixStateModule.autoMigrateLegacyMatrixState).mockResolvedValue({
      migrated: true,
      changes: ["Migrated legacy sync state"],
      warnings: [],
    });
    vi.mocked(matrixCryptoModule.autoPrepareLegacyMatrixCrypto).mockResolvedValue({
      migrated: true,
      changes: ["Prepared recovery key export"],
      warnings: [],
    });

    const result = await applyMatrixDoctorRepair({
      cfg: {},
      env: process.env,
    });

    expect(result.changes).toEqual([
      expect.stringContaining("Matrix migration snapshot created"),
      expect.stringContaining("Matrix plugin upgraded in place."),
      expect.stringContaining("Matrix encrypted-state migration prepared."),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("removes stale Matrix plugin config when install path is missing", async () => {
    const missingPath = path.join(tmpdir(), "openclaw-matrix-stale-cleanup-test-" + Date.now());
    await fs.rm(missingPath, { recursive: true, force: true });

    const cfg = {
      plugins: {
        installs: {
          matrix: {
            source: "path" as const,
            sourcePath: missingPath,
            installPath: missingPath,
          },
        },
        load: {
          paths: [missingPath, "/other/path"],
        },
        allow: ["matrix", "other-plugin"],
      },
    };

    const result = await cleanStaleMatrixPluginConfig(cfg);

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain("Removed stale Matrix plugin references");
    expect(result.changes[0]).toContain("install record");
    expect(result.changes[0]).toContain("load path");
    expect(result.changes[0]).toContain(missingPath);
    // Config should have stale refs removed
    expect(result.config.plugins?.installs?.matrix).toBeUndefined();
    expect(result.config.plugins?.load?.paths).toEqual(["/other/path"]);
    // Allowlist should have matrix removed but keep other entries
    expect(result.config.plugins?.allow).toEqual(["other-plugin"]);
  });

  it("returns no changes when Matrix install path exists", async () => {
    const existingPath = tmpdir();
    const cfg = {
      plugins: {
        installs: {
          matrix: {
            source: "path" as const,
            sourcePath: existingPath,
            installPath: existingPath,
          },
        },
      },
    };

    const result = await cleanStaleMatrixPluginConfig(cfg);
    expect(result.changes).toHaveLength(0);
    expect(result.config).toBe(cfg);
  });

  it("returns no changes when no Matrix install record exists", async () => {
    const result = await cleanStaleMatrixPluginConfig({});
    expect(result.changes).toHaveLength(0);
  });

  it("collects matrix preview and install warnings through the provider sequence", async () => {
    const matrixStateModule = await import("../../../infra/matrix-legacy-state.js");
    const matrixCryptoModule = await import("../../../infra/matrix-legacy-crypto.js");

    const stateSpy = vi.spyOn(matrixStateModule, "detectLegacyMatrixState").mockReturnValue({
      accountId: "default",
      legacyStoragePath: "/tmp/legacy-sync.json",
      targetStoragePath: "/tmp/new-sync.json",
      legacyCryptoPath: "/tmp/legacy-crypto.json",
      targetCryptoPath: "/tmp/new-crypto.json",
      selectionNote: "Picked the newest account.",
      targetRootDir: "/tmp/account-root",
    });
    const cryptoSpy = vi.spyOn(matrixCryptoModule, "detectLegacyMatrixCrypto").mockReturnValue({
      warnings: ["matrix warning"],
      plans: [],
    });

    try {
      const result = await runMatrixDoctorSequence({
        cfg: {},
        env: process.env,
        shouldRepair: false,
      });

      expect(result.changeNotes).toEqual([]);
      expect(result.warningNotes).toEqual([
        expect.stringContaining("Matrix plugin upgraded in place."),
        "- matrix warning",
      ]);
    } finally {
      stateSpy.mockRestore();
      cryptoSpy.mockRestore();
    }
  });
});
