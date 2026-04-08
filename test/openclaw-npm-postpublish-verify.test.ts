import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPublishedInstallScenarios,
  collectInstalledMirroredRootDependencyManifestErrors,
  collectInstalledPackageErrors,
  resolveInstalledBinaryPath,
} from "../scripts/openclaw-npm-postpublish-verify.ts";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/runtime-sidecar-paths.ts";

describe("buildPublishedInstallScenarios", () => {
  it("uses a single fresh scenario for plain stable releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23"],
        expectedVersion: "2026.3.23",
      },
    ]);
  });

  it("adds a stable-to-correction upgrade scenario for correction releases", () => {
    expect(buildPublishedInstallScenarios("2026.3.23-2")).toEqual([
      {
        name: "fresh-exact",
        installSpecs: ["openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
      {
        name: "upgrade-from-base-stable",
        installSpecs: ["openclaw@2026.3.23", "openclaw@2026.3.23-2"],
        expectedVersion: "2026.3.23-2",
      },
    ]);
  });
});

describe("collectInstalledPackageErrors", () => {
  it("flags version mismatches and missing runtime sidecars", () => {
    const errors = collectInstalledPackageErrors({
      expectedVersion: "2026.3.23-2",
      installedVersion: "2026.3.23",
      packageRoot: "/tmp/empty-openclaw",
    });

    expect(errors[0]).toBe(
      "installed package version mismatch: expected 2026.3.23-2, found 2026.3.23.",
    );
    expect(errors).toEqual(
      expect.arrayContaining(
        BUNDLED_RUNTIME_SIDECAR_PATHS.map(
          (relativePath) =>
            `installed package is missing required bundled runtime sidecar: ${relativePath}`,
        ),
      ),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1 + BUNDLED_RUNTIME_SIDECAR_PATHS.length);
  });
});

describe("resolveInstalledBinaryPath", () => {
  it("uses the Unix global bin path on non-Windows platforms", () => {
    expect(resolveInstalledBinaryPath("/tmp/openclaw-prefix", "darwin")).toBe(
      "/tmp/openclaw-prefix/bin/openclaw",
    );
  });

  it("uses the Windows npm shim path on win32", () => {
    expect(resolveInstalledBinaryPath("C:/openclaw-prefix", "win32")).toBe(
      "C:/openclaw-prefix/openclaw.cmd",
    );
  });
});

describe("collectInstalledMirroredRootDependencyManifestErrors", () => {
  function makeInstalledPackageRoot(): string {
    return mkdtempSync(join(tmpdir(), "openclaw-postpublish-installed-"));
  }

  function writePackageFile(root: string, relativePath: string, value: unknown): void {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }

  it("flags missing mirrored root dependencies required by bundled extensions", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.9",
        dependencies: {},
      });
      writePackageFile(packageRoot, "dist/extensions/slack/package.json", {
        dependencies: {
          "@slack/web-api": "^7.15.0",
        },
        openclaw: {
          releaseChecks: {
            rootDependencyMirrorAllowlist: ["@slack/web-api"],
          },
        },
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package is missing mirrored root runtime dependency '@slack/web-api' required by a bundled extension.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("accepts mirrored root dependencies declared in package optionalDependencies", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.9",
        optionalDependencies: {
          "@discordjs/opus": "^0.10.0",
        },
      });
      writePackageFile(packageRoot, "dist/extensions/discord/package.json", {
        optionalDependencies: {
          "@discordjs/opus": "^0.10.0",
        },
        openclaw: {
          releaseChecks: {
            rootDependencyMirrorAllowlist: ["@discordjs/opus"],
          },
        },
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags mirrored root dependency version mismatches", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.9",
        dependencies: {
          "@slack/web-api": "^7.16.0",
        },
      });
      writePackageFile(packageRoot, "dist/extensions/slack/package.json", {
        dependencies: {
          "@slack/web-api": "^7.15.0",
        },
        openclaw: {
          releaseChecks: {
            rootDependencyMirrorAllowlist: ["@slack/web-api"],
          },
        },
      });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        "installed package mirrored dependency '@slack/web-api' version mismatch: root '^7.16.0', extension '^7.15.0'.",
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags malformed bundled extension manifests instead of silently skipping them", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.9",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist/extensions/slack"), { recursive: true });
      writeFileSync(
        join(packageRoot, "dist/extensions/slack/package.json"),
        '{\n  "openclaw": { invalid json\n',
        "utf8",
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        expect.stringContaining("installed bundled extension manifest invalid: failed to parse"),
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("flags bundled extension directories that are missing package.json", () => {
    const packageRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.9",
        dependencies: {},
      });
      mkdirSync(join(packageRoot, "dist/extensions/slack"), { recursive: true });

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        `installed bundled extension manifest missing: ${join(packageRoot, "dist/extensions/slack/package.json")}.`,
      ]);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it("rejects bundled extension manifests that are not regular files", () => {
    const packageRoot = makeInstalledPackageRoot();
    const outsideManifestRoot = makeInstalledPackageRoot();

    try {
      writePackageFile(packageRoot, "package.json", {
        version: "2026.4.9",
        dependencies: {},
      });
      writePackageFile(outsideManifestRoot, "package.json", {
        dependencies: {
          "@slack/web-api": "^7.15.0",
        },
      });
      mkdirSync(join(packageRoot, "dist/extensions/slack"), { recursive: true });
      symlinkSync(
        join(outsideManifestRoot, "package.json"),
        join(packageRoot, "dist/extensions/slack/package.json"),
      );

      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)).toEqual([
        expect.stringContaining("installed bundled extension manifest invalid: failed to parse"),
      ]);
      expect(collectInstalledMirroredRootDependencyManifestErrors(packageRoot)[0]).toContain(
        "manifest must be a regular file",
      );
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
      rmSync(outsideManifestRoot, { recursive: true, force: true });
    }
  });
});
