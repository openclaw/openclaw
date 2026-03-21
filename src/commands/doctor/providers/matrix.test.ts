import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectMatrixInstallPathWarnings,
  formatMatrixLegacyCryptoPreview,
  formatMatrixLegacyStatePreview,
} from "./matrix.js";

describe("doctor matrix provider helpers", () => {
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
    expect(warnings[2]).toContain("openclaw plugins install ./extensions/matrix");
  });
});
