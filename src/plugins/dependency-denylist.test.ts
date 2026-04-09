import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockedInstallDependencyPackageNames,
  findBlockedManifestDependencies,
} from "./dependency-denylist.js";

type RootPackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, string>;
  };
};

function readRootManifest(): RootPackageManifest {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
  ) as RootPackageManifest;
}

function readRootLockfile(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "pnpm-lock.yaml"), "utf8");
}

describe("dependency denylist guardrails", () => {
  it("pins the axios override to the official 1.14.0 release", () => {
    const manifest = readRootManifest();
    expect(manifest.pnpm?.overrides?.axios).toBe("1.14.0");
  });

  it("keeps blocked packages out of the root manifest", () => {
    const manifest = readRootManifest();
    expect(findBlockedManifestDependencies(manifest)).toEqual([]);
  });

  it("keeps blocked packages out of the lockfile graph", () => {
    const lockfile = readRootLockfile();
    for (const packageName of blockedInstallDependencyPackageNames) {
      expect(lockfile).not.toContain(`\n  ${packageName}@`);
      expect(lockfile).not.toContain(`\n      ${packageName}: `);
    }
  });
});
