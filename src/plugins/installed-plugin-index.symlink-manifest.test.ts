import fs from "node:fs";
import path from "node:path";
// Covers hashing installed-plugin manifests whose retained path reaches the
// canonical plugin root through a symlinked parent directory (#148595).
import { afterEach, describe, expect, it } from "vitest";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-index-symlink", tempDirs);
}

function makeRecord(rootDir: string, manifestPath: string): PluginManifestRecord {
  return {
    id: "demo",
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "config",
    rootDir,
    source: path.join(rootDir, "index.ts"),
    manifestPath,
  } as unknown as PluginManifestRecord;
}

describe("installed plugin index manifest hashing across symlinked roots", () => {
  it.runIf(process.platform !== "win32")(
    "hashes a manifest whose lexical path aliases the canonical plugin root",
    () => {
      const realParent = makeTempDir();
      const realRoot = path.join(realParent, "example-plugin");
      fs.mkdirSync(realRoot, { recursive: true });
      fs.writeFileSync(
        path.join(realRoot, "openclaw.plugin.json"),
        JSON.stringify({ id: "demo" }),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(realRoot, "index.ts"),
        "throw new Error('runtime entry should not load while building the installed plugin index');\n",
        "utf-8",
      );

      const aliasParent = makeTempDir();
      const aliasRoot = path.join(aliasParent, "projects", "example-plugin");
      fs.symlinkSync(realParent, path.join(aliasParent, "projects"), "dir");

      const diagnostics: Array<{ message?: string }> = [];
      const records = buildInstalledPluginIndexRecords({
        candidates: [
          recordPluginCandidateInstallOwner(
            {
              idHint: "demo",
              source: path.join(realRoot, "index.ts"),
              rootDir: realRoot,
              origin: "config",
            },
            undefined,
          ),
        ],
        registry: {
          plugins: [
            // Canonical rootDir (what the registry records after resolution)
            // combined with the lexical manifest path the manifest cache kept.
            makeRecord(fs.realpathSync(realRoot), path.join(aliasRoot, "openclaw.plugin.json")),
          ],
          diagnostics: [],
        },
        diagnostics: diagnostics as never,
        installRecords: {},
      });

      expect(records[0]?.manifestHash).not.toBe("");
      expect(diagnostics).toStrictEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "still rejects a manifest that is genuinely outside the plugin root",
    () => {
      const rootDir = makeTempDir();
      fs.writeFileSync(path.join(rootDir, "index.ts"), "export {};\n", "utf-8");
      const outsideDir = makeTempDir();
      const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
      fs.writeFileSync(outsideManifest, JSON.stringify({ id: "imposter" }), "utf-8");

      const diagnostics: Array<{ message?: string }> = [];
      const records = buildInstalledPluginIndexRecords({
        candidates: [
          recordPluginCandidateInstallOwner(
            { idHint: "demo", source: path.join(rootDir, "index.ts"), rootDir, origin: "config" },
            undefined,
          ),
        ],
        registry: {
          plugins: [makeRecord(rootDir, outsideManifest)],
          diagnostics: [],
        },
        diagnostics: diagnostics as never,
        installRecords: {},
      });

      expect(records[0]?.manifestHash).toBe("");
      expect(diagnostics.length).toBeGreaterThan(0);
    },
  );
});
