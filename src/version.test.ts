// Tests package version resolution and generated version metadata.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";
import { withEnv } from "./test-utils/env.js";
import {
  VERSION,
  readBuildIdFromBuildInfoForModuleUrl,
  readVersionFromBuildInfoForModuleUrl,
  resolveCompatibilityHostVersion,
  readVersionFromPackageJsonForModuleUrl,
  resolveBinaryVersion,
  resolveRuntimeServiceVersion,
  resolveUsableRuntimeVersion,
  resolveVersionFromModuleUrl,
} from "./version.js";

const versionFixtureRoot = createSuiteTempRootTracker({ prefix: "openclaw-version-" });

beforeAll(async () => {
  await versionFixtureRoot.setup();
});
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
    // Reporting source metadata would hide a stale, unrebuilt runtime.
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
    const root = await versionFixtureRoot.make("oversized-build-id");
    await fs.mkdir(path.join(root, "dist/plugin-sdk"), { recursive: true });
    await fs.writeFile(
      path.join(root, "dist/build-info.json"),
      JSON.stringify({ buildId: "x".repeat(97) }),
    );
    await fs.writeFile(
      path.join(root, "build-info.json"),
      JSON.stringify({ buildId: "x".repeat(96) }),
    );
    const moduleUrl = pathToFileURL(path.join(root, "dist/plugin-sdk/core.js")).href;
    expect(readBuildIdFromBuildInfoForModuleUrl(moduleUrl)).toBe("x".repeat(96));
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
      resolveBinaryVersion({ moduleUrl: url, bundledVersion, fallback: "0.0.0" });
    expect(resolve(moduleUrl, "8.8.8")).toBe("2.3.4");
    expect(resolve("not-a-valid-url", "8.8.8")).toBe("8.8.8");
    expect(resolve("not-a-valid-url", "   ")).toBe("0.0.0");
  });

  it("prefers runtime VERSION over stale OPENCLAW_VERSION for compatibility checks", () => {
    withEnv(
      {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        OPENCLAW_VERSION: "2026.3.25",
        npm_package_version: "2026.3.25-package",
      },
      () => {
        expect(resolveCompatibilityHostVersion()).toBe(VERSION);
      },
    );
  });

  it("keeps explicit env-object overrides for compatibility checks in tests", () => {
    expect(
      resolveCompatibilityHostVersion({
        OPENCLAW_VERSION: "2026.3.99",
        npm_package_version: "2026.3.97",
      }),
    ).toBe("2026.3.99");
  });

  it("prefers explicit compatibility host overrides over runtime and stale env versions", () => {
    expect(
      resolveCompatibilityHostVersion({
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.4.8",
        OPENCLAW_VERSION: "2026.3.99",
        npm_package_version: "2026.3.97",
      }),
    ).toBe("2026.4.8");
  });

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
