import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";
import { withEnv } from "./test-utils/env.js";
import {
  VERSION,
  readBuildIdFromBuildInfoForModuleUrl,
  readBuildProvenanceForModuleUrl,
  readVersionFromBuildInfoForModuleUrl,
  resolveCompatibilityHostVersion,
  readVersionFromPackageJsonForModuleUrl,
  resolveBinaryVersion,
  resolveRuntimeServiceVersion,
  resolveUsableRuntimeVersion,
  resolveVersionFromModuleUrl,
} from "./version.js";

const versionFixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-version-" });

beforeAll(() => versionFixtureRoot.setup());
afterAll(() => versionFixtureRoot.cleanup());

async function versionFixture(files: Record<string, unknown>) {
  const root = await versionFixtureRoot.make("case");
  await fs.mkdir(path.join(root, "dist/plugin-sdk"), { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), JSON.stringify(value), "utf-8");
  }
  return pathToFileURL(path.join(root, "dist/plugin-sdk/core.js")).href;
}

describe("version resolution", () => {
  it("reports the built version when dist lags the source package version", async () => {
    const moduleUrl = await versionFixture({
      "package.json": { name: "openclaw", version: "2026.9.2" },
      "build-info.json": { version: "2026.8.1" },
    });
    expect(readVersionFromPackageJsonForModuleUrl(moduleUrl)).toBe("2026.9.2");
    expect(resolveVersionFromModuleUrl(moduleUrl)).toBe("2026.8.1");
  });

  it("reads the bounded immutable build id from generated provenance", async () => {
    const valid = await versionFixture({ "build-info.json": { buildId: "build-a" } });
    const oversized = await versionFixture({ "build-info.json": { buildId: "x".repeat(97) } });
    expect(readBuildIdFromBuildInfoForModuleUrl(valid)).toBe("build-a");
    expect(readBuildIdFromBuildInfoForModuleUrl(oversized)).toBeNull();
  });

  it("continues past an oversized build id to the next candidate", async () => {
    const moduleUrl = await versionFixture({
      "dist/build-info.json": { buildId: "x".repeat(97) },
      "build-info.json": { buildId: "x".repeat(96) },
    });
    expect(readBuildIdFromBuildInfoForModuleUrl(moduleUrl)).toBe("x".repeat(96));
    // Provenance names the file that actually supplied the ID, not the first candidate found.
    expect(readBuildProvenanceForModuleUrl(moduleUrl)).toEqual({
      buildId: "x".repeat(96),
      buildInfoPath: await fs.realpath(fileURLToPath(new URL("../../build-info.json", moduleUrl))),
    });
  });

  it("captures the build record beside the build id", async () => {
    const moduleUrl = await versionFixture({
      "build-info.json": {
        version: "2026.10.22",
        commit: "a".repeat(40),
        builtAt: "2026-10-22T00:00:00.000Z",
        buildId: "explicit-ui-build",
      },
    });
    expect(readBuildProvenanceForModuleUrl(moduleUrl)).toEqual({
      buildId: "explicit-ui-build",
      version: "2026.10.22",
      commit: "a".repeat(40),
      builtAt: "2026-10-22T00:00:00.000Z",
      buildInfoPath: await fs.realpath(fileURLToPath(new URL("../../build-info.json", moduleUrl))),
    });
  });

  it("has no build provenance without a usable build id", async () => {
    const missing = await versionFixture({ "package.json": { name: "openclaw", version: "1" } });
    const empty = await versionFixture({ "build-info.json": { version: "1", buildId: " " } });
    expect(readBuildProvenanceForModuleUrl(missing)).toBeNull();
    expect(readBuildProvenanceForModuleUrl(empty)).toBeNull();
  });

  it("captures the runtime commit from startup provenance once", async () => {
    let startupCommit = "aaaaaaa";
    vi.doMock("./infra/git-commit.js", () => ({
      resolveLoadedCommitHash: () => startupCommit,
    }));
    vi.resetModules();
    try {
      const runtimeVersion = await import("./version.js");
      expect(runtimeVersion.resolveRuntimeServiceCommit()).toBe("aaaaaaa");
      startupCommit = "bbbbbbb";
      expect(runtimeVersion.resolveRuntimeServiceCommit()).toBe("aaaaaaa");
    } finally {
      vi.doUnmock("./infra/git-commit.js");
      vi.resetModules();
    }
  });

  it("ignores non-openclaw package and blank build-info versions", async () => {
    const moduleUrl = await versionFixture({
      "package.json": { name: "other-package", version: "9.9.9" },
      "build-info.json": { version: "  " },
    });
    expect([
      readVersionFromPackageJsonForModuleUrl(moduleUrl),
      readVersionFromBuildInfoForModuleUrl(moduleUrl),
      resolveVersionFromModuleUrl(moduleUrl),
    ]).toEqual([null, null, null]);
  });

  it("resolves binary version with explicit precedence", async () => {
    const moduleUrl = await versionFixture({
      "package.json": { name: "openclaw", version: "2.3.4" },
    });
    const resolve = (url: string, bundledVersion: string) =>
      resolveBinaryVersion({ moduleUrl: url, bundledVersion });
    expect(resolve(moduleUrl, "8.8.8")).toBe("2.3.4");
    expect(resolve("not-a-valid-url", "8.8.8")).toBe("8.8.8");
    expect(resolve("not-a-valid-url", "   ")).toBe("0.0.0");
  });

  it.each([
    [true, undefined, VERSION],
    [false, undefined, "2026.3.99"],
    [false, "2026.4.8", "2026.4.8"],
  ] as const)(
    "resolves compatibility env (process: %s, override: %s)",
    (processEnv, override, expected) => {
      const env = {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: override,
        OPENCLAW_VERSION: "2026.3.99",
        npm_package_version: "2026.3.97",
      };
      withEnv(env, () => {
        expect(resolveCompatibilityHostVersion(processEnv ? undefined : env)).toBe(expected);
      });
    },
  );

  it("normalizes runtime version candidate for fallback handling", () => {
    expect(
      [undefined, "", " \t ", "0.0.0", " 0.0.0 ", "2026.3.2", " 2026.3.2 "].map(
        resolveUsableRuntimeVersion,
      ),
    ).toEqual([undefined, undefined, undefined, undefined, undefined, "2026.3.2", "2026.3.2"]);
  });

  it("prefers runtime VERSION over package markers and ignores unusable env values", () => {
    const resolve = (OPENCLAW_VERSION: string, npm_package_version: string, fallback?: string) =>
      resolveRuntimeServiceVersion({ OPENCLAW_VERSION, npm_package_version }, fallback);
    expect(resolve("   ", "1.0.0")).toBe(VERSION);
    expect(resolve(" ", " 1.0.0-package ")).toBe(VERSION);
    expect(resolve("", "", "fallback")).toBe(VERSION);
    expect(resolve("undefined", "1.0.0-package")).toBe(VERSION);
  });
});
