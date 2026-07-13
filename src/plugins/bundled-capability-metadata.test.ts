// Verifies bundled capability metadata emitted by plugins.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";
import { normalizeBundledPluginStringList } from "./bundled-plugin-scan.js";
import { pluginTestRepoRoot as repoRoot } from "./generated-plugin-test-helpers.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import type { PluginManifest } from "./manifest.js";

function listGitExtensionPackagePaths(extensionsDir: string): string[] | null {
  const relativeDir = toRepoRelativePath(repoRoot, extensionsDir);
  if (!relativeDir || relativeDir.startsWith("..") || path.isAbsolute(relativeDir)) {
    return null;
  }
  const files = listGitTrackedFiles({ repoRoot, pathspecs: relativeDir });
  if (!files) {
    return null;
  }
  return files
    .filter((line) => /^extensions\/[^/]+\/package\.json$/u.test(line))
    .map((line) => path.join(repoRoot, ...line.split("/")))
    .toSorted();
}

function listExtensionPackagePaths(extensionsDir: string): string[] {
  const gitPaths = listGitExtensionPackagePaths(extensionsDir);
  if (gitPaths) {
    return gitPaths;
  }

  return fs
    .readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(extensionsDir, entry.name, "package.json"))
    .filter((packagePath) => fs.existsSync(packagePath));
}

function readManifestRecords(): PluginManifest[] {
  const extensionsDir = path.join(repoRoot, "extensions");
  return listExtensionPackagePaths(extensionsDir)
    .filter((packagePath) => {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8")) as {
        openclaw?: OpenClawPackageManifest;
      };
      return normalizeBundledPluginStringList(packageJson.openclaw?.extensions).length > 0;
    })
    .map(
      (packagePath) =>
        JSON.parse(
          fs.readFileSync(path.join(path.dirname(packagePath), "openclaw.plugin.json"), "utf-8"),
        ) as PluginManifest,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

describe("bundled capability metadata", () => {
  it("lists bundled extension packages from git without scanning extension dirs", () => {
    const extensionsDir = path.join(repoRoot, "extensions");
    expectNoReaddirSyncDuring(() => {
      const packagePaths = listExtensionPackagePaths(extensionsDir);

      expect(packagePaths.length).toBeGreaterThan(0);
      expect(packagePaths.every((file) => file.endsWith("package.json"))).toBe(true);
    });
  });
});
