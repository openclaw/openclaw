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
  overrides?: Record<string, string | Record<string, string>>;
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
  it("finds blocked package names on vendored manifests", () => {
    expect(
      findBlockedManifestDependencies({
        name: "plain-crypto-js",
      }),
    ).toEqual([
      {
        dependencyName: "plain-crypto-js",
        field: "name",
      },
    ]);
  });

  it("finds blocked packages declared through npm alias specs", () => {
    expect(
      findBlockedManifestDependencies({
        dependencies: {
          "safe-name": "npm:plain-crypto-js@^4.2.1",
        },
        peerDependencies: {
          "@alias/safe": "npm:@scope/ok@^1.0.0",
        },
      }),
    ).toEqual([
      {
        dependencyName: "plain-crypto-js",
        declaredAs: "safe-name",
        field: "dependencies",
      },
    ]);
  });

  it("finds blocked packages declared through nested override alias specs", () => {
    expect(
      findBlockedManifestDependencies({
        overrides: {
          axios: "1.15.0",
          "@scope/parent": {
            "safe-name": "npm:plain-crypto-js@^4.2.1",
          },
        },
      }),
    ).toEqual([
      {
        dependencyName: "plain-crypto-js",
        declaredAs: "@scope/parent > safe-name",
        field: "overrides",
      },
    ]);
  });

  it("pins the axios override to an exact version", () => {
    const manifest = readRootManifest();
    expect(manifest.overrides?.axios).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.pnpm?.overrides?.axios).toMatch(/^\d+\.\d+\.\d+$/);
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
