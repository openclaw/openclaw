import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../../../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../../../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");
const COMMANDS_ROOT = path.join(SRC_ROOT, "commands");
const DOCTOR_ROOT = path.join(COMMANDS_ROOT, "doctor");
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
  const relativeRoot = toRepoRelativePath(REPO_ROOT, dir);
  const files = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  if (!files) {
    throw new Error("Cannot verify Doctor ownership without the tracked source inventory.");
  }
  return files
    .map((file) => path.join(REPO_ROOT, file))
    .filter(isOwnedSourceFile)
    .toSorted();
}

function isOwnedSourceFile(file: string): boolean {
  return file.endsWith(".ts") && !file.endsWith(".test.ts") && !isDoctorSourceFile(file);
}

function isDoctorSourceFile(file: string): boolean {
  if (path.dirname(file) === COMMANDS_ROOT && /^doctor[.-]/.test(path.basename(file))) {
    return true;
  }
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
  it("recognizes Doctor command modules without exempting neighboring source", () => {
    expect(isOwnedSourceFile(path.join(COMMANDS_ROOT, "doctor-heartbeat-retirement.ts"))).toBe(
      false,
    );
    expect(isOwnedSourceFile(path.join(COMMANDS_ROOT, "status.ts"))).toBe(true);
    expect(isOwnedSourceFile(path.join(COMMANDS_ROOT, "doctor-adapter", "runtime.ts"))).toBe(true);
    expect(isOwnedSourceFile(path.join(SRC_ROOT, "infra", "doctor-adapter.ts"))).toBe(true);
  });

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
