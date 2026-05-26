import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";

describe("installed manifest registry fingerprint cache", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("reuses the fingerprint for the same installed index object without re-statting files", () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-installed-fingerprint-"));
    tempDirs.push(pluginDir);
    const manifestPath = path.join(pluginDir, "plugin.json");
    const packageJsonPath = path.join(pluginDir, "package.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ id: "test-plugin" }), "utf-8");
    fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "test-plugin" }), "utf-8");
    const index = {
      version: 1,
      hostContractVersion: "test-host",
      compatRegistryVersion: "test-compat",
      migrationVersion: 1,
      policyHash: "test-policy",
      generatedAtMs: 1,
      installRecords: {},
      diagnostics: [],
      plugins: [
        {
          pluginId: "test-plugin",
          manifestPath,
          manifestHash: "test-manifest-hash",
          packageJson: {
            path: "package.json",
            hash: "test-package-hash",
          },
          rootDir: pluginDir,
          origin: "external",
          enabled: true,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        },
      ],
    } as InstalledPluginIndex;
    const statSpy = vi.spyOn(fs, "statSync");

    const first = resolveInstalledManifestRegistryIndexFingerprint(index);
    const statCallsAfterFirst = statSpy.mock.calls.length;
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).toBe(first);
    expect(statCallsAfterFirst).toBeGreaterThan(0);
    expect(statSpy.mock.calls.length).toBe(statCallsAfterFirst);
  });
});
