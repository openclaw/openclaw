import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withAugmentedPluginNpmManifestForPackage } from "../../scripts/lib/plugin-npm-package-manifest.mjs";
import { collectPublishablePluginPackages } from "../../scripts/lib/plugin-npm-release.ts";
import { isScannable, scanDirectoryWithSummary } from "../security/skill-scanner.js";

type NpmPackFile = {
  path?: unknown;
};

type NpmPackResult = {
  files?: unknown;
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function parseNpmPackFiles(raw: string, packageName: string): string[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${packageName}: npm pack --dry-run did not return one package result.`);
  }

  const result = parsed[0] as NpmPackResult;
  if (!Array.isArray(result.files)) {
    throw new Error(`${packageName}: npm pack --dry-run did not return a files list.`);
  }

  return result.files
    .map((entry) => (entry as NpmPackFile).path)
    .filter((packedPath): packedPath is string => typeof packedPath === "string")
    .toSorted();
}

function collectNpmPackedFiles(packageDir: string, packageName: string): string[] {
  return withAugmentedPluginNpmManifestForPackage({ packageDir }, ({ packageDir: cwd }) => {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseNpmPackFiles(raw, packageName);
  });
}

function isScannerWalkedPackedPath(packedPath: string): boolean {
  return (
    isScannable(packedPath) &&
    packedPath.split(/[\\/]/).every((segment) => {
      return segment.length > 0 && segment !== "node_modules" && !segment.startsWith(".");
    })
  );
}

function stageScannerRelevantPackedFiles(
  packageDir: string,
  packedFiles: readonly string[],
): string {
  const stageDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-scan-"));
  tempDirs.push(stageDir);

  for (const packedPath of packedFiles) {
    if (!isScannerWalkedPackedPath(packedPath)) {
      continue;
    }

    const source = resolve(packageDir, packedPath);
    const target = join(stageDir, ...packedPath.split(/[\\/]/));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }

  return stageDir;
}

describe("publishable plugin npm package install security scan", () => {
  it("keeps npm-published plugin files clear of env-harvesting hits", async () => {
    const failures: string[] = [];

    for (const plugin of collectPublishablePluginPackages()) {
      const packedFiles = collectNpmPackedFiles(plugin.packageDir, plugin.packageName);
      const stageDir = stageScannerRelevantPackedFiles(plugin.packageDir, packedFiles);
      const summary = await scanDirectoryWithSummary(stageDir, {
        excludeTestFiles: true,
        maxFiles: 10_000,
      });

      for (const finding of summary.findings) {
        if (finding.ruleId !== "env-harvesting" || finding.severity !== "critical") {
          continue;
        }
        failures.push(
          [
            plugin.packageName,
            relative(stageDir, finding.file).split(sep).join("/"),
            `${finding.line}`,
            finding.evidence,
          ].join(":"),
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
