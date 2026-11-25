import { spawnSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectNoFsSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedRuntimeResolverRefs = new Set([
  "src/commands/doctor.e2e-harness.ts",
  "src/infra/outbound/channel-bootstrap.runtime.ts",
  "src/plugins/capability-provider-runtime.ts",
  "src/plugins/loader-runtime-load.ts",
  "src/plugins/loader-runtime-registry.ts",
  "src/plugins/loader.ts",
  "src/plugins/providers.runtime-core.ts",
]);

function listSourceFiles(dir: string): string[] {
  const relativeRoot = toRepoRelativePath(repoRoot, dir) || ".";
  const files = listGitTrackedFiles({ repoRoot, pathspecs: relativeRoot });
  if (files) {
    return files
      .map((file) => resolve(repoRoot, file))
      .filter((filePath) => fs.existsSync(filePath) && isProductionTypeScriptFile(filePath))
      .toSorted();
  }
  const result = spawnSync("find", [dir, "-type", "f", "-name", "*.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 4,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return listSourceFilesByDirectory(dir);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => resolve(repoRoot, file))
    .filter(isProductionTypeScriptFile)
    .toSorted();
}

function listSourceFilesByDirectory(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((entry) => {
    if (entry === "node_modules" || entry === "dist") {
      return [];
    }
    const path = resolve(dir, entry);
    if (fs.statSync(path).isDirectory()) {
      return listSourceFilesByDirectory(path);
    }
    return isProductionTypeScriptFile(path) ? [path] : [];
  });
}

function isProductionTypeScriptFile(path: string): boolean {
  return (
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".test.tsx") &&
    !/\.test-(?:fixtures|harness|helpers|mocks|setup|support|utils)\.tsx?$/u.test(path)
  );
}

describe("runtime plugin registry boundary", () => {
  it("lists source files without scanning src in-process", () => {
    expectNoFsSyncDuring(() => {
      const files = listSourceFiles(resolve(repoRoot, "src"));

      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isProductionTypeScriptFile)).toBe(true);
    }, ["readdirSync", "statSync"]);
  });

  it("keeps runtime registry resolution behind the loader boundary", () => {
    const offenders = listSourceFiles(resolve(repoRoot, "src"))
      .filter(
        (file) =>
          !allowedRuntimeResolverRefs.has(relative(repoRoot, file)) &&
          readFileSync(file, "utf8").includes("resolveRuntimePluginRegistry"),
      )
      .map((file) => relative(repoRoot, file));

    expect(offenders).toStrictEqual([]);
  });
});
