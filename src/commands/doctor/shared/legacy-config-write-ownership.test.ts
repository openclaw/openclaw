import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const DOCTOR_ROOT = path.join(SRC_ROOT, "commands", "doctor");
const ownershipRules = [
  [
    "migrateLegacyConfig",
    /migrateLegacyConfig\s*:\s*true/,
    "migrateLegacyConfig:true outside doctor",
  ],
  [
    "legacy-config-migrate",
    /legacy-config-migrate(?:\.js)?|legacy-config-migrations(?:\.[\w-]+)?(?:\.js)?/,
    "doctor legacy migration module referenced outside doctor",
  ],
] as const;

function collectSourceFiles(dir: string): string[] {
  return listGitSourceFiles(dir) ?? listFindSourceFiles(dir) ?? collectSourceFilesByDirectory(dir);
}

function listGitSourceFiles(dir: string): string[] | null {
  const relativeRoot = toRepoRelativePath(REPO_ROOT, dir);
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  if (!files) {
    return null;
  }
  return files
    .map((file) => path.join(REPO_ROOT, file))
    .filter((filePath) => fs.existsSync(filePath) && isOwnedSourceFile(filePath))
    .toSorted();
}

function listFindSourceFiles(dir: string): string[] | null {
  const result = spawnSync(
    "find",
    [
      dir,
      "(",
      "-name",
      "dist",
      "-o",
      "-name",
      "node_modules",
      ")",
      "-prune",
      "-o",
      "-type",
      "f",
      "-name",
      "*.ts",
      "-print",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(isOwnedSourceFile)
    .toSorted();
}

function collectSourceFilesByDirectory(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath !== DOCTOR_ROOT) {
        collectSourceFilesByDirectory(fullPath, acc);
      }
    } else if (entry.isFile() && isOwnedSourceFile(fullPath)) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function isOwnedSourceFile(file: string): boolean {
  return file.endsWith(".ts") && !file.endsWith(".test.ts") && !isUnderDoctorRoot(file);
}

function isUnderDoctorRoot(file: string): boolean {
  const relativePath = path.relative(DOCTOR_ROOT, file);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function collectViolations(files: string[]): string[] {
  return files.flatMap((file) => {
    const rel = toRepoRelativePath(REPO_ROOT, file);
    const sourceBytes = fs.readFileSync(file);
    return ownershipRules.flatMap(([needle, pattern, message]) =>
      sourceBytes.includes(needle) && pattern.test(sourceBytes.toString("utf8"))
        ? [`${rel}: ${message}`]
        : [],
    );
  });
}

describe("legacy config write ownership", () => {
  it("lists ownership scan files without scanning source directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const files = collectSourceFiles(SRC_ROOT);

      expect(files.length).toBeGreaterThan(0);
      expect(files.every(isOwnedSourceFile)).toBe(true);
    });
  });

  it("keeps legacy config repair flags and migration modules under doctor", () => {
    const files = collectSourceFiles(SRC_ROOT);
    expect(collectViolations(files)).toStrictEqual([]);
  });
});
