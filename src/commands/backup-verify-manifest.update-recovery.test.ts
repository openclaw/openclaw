import path from "node:path";
import { expect, it } from "vitest";
import { parseUpdateRecoveryBackupManifest } from "./backup-verify-manifest.js";

it("rejects an update-recovery root without its configuration inventory", () => {
  const stateDir = path.resolve("fixture", "state");
  const manifest = {
    schemaVersion: 1,
    kind: "update-recovery",
    runId: "fixture-run",
    installRoot: path.resolve("fixture", "install"),
    stateDir,
    configPath: path.join(stateDir, "openclaw.json"),
    configPaths: [path.join(stateDir, "openclaw.json")],
    creator: { host: "fixture", pid: 1, startIdentity: "1" },
    drivers: [],
    createdAt: "2026-09-10T00:00:00.000Z",
    roots: [stateDir],
    excludedRoots: [],
    protectedPaths: [path.join(stateDir, "openclaw.json")],
    entries: [{ kind: "directory", sourcePath: stateDir, mode: 0o700 }],
  };
  expect(() => parseUpdateRecoveryBackupManifest(JSON.stringify(manifest))).toThrow(
    /configuration inventory/,
  );
  expect(() =>
    parseUpdateRecoveryBackupManifest(
      JSON.stringify({
        ...manifest,
        entries: [
          ...manifest.entries,
          { kind: "missing", sourcePath: manifest.configPath, sqlite: false, directory: false },
        ],
      }),
    ),
  ).not.toThrow();
  expect(() =>
    parseUpdateRecoveryBackupManifest(
      JSON.stringify({
        ...manifest,
        configPaths: [manifest.configPath, path.join(stateDir, "included.json")],
        entries: [
          ...manifest.entries,
          { kind: "missing", sourcePath: manifest.configPath, sqlite: false, directory: false },
        ],
      }),
    ),
  ).toThrow(/configuration inventory/);
});
