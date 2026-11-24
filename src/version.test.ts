import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "./test-helpers/temp-dir.js";
import { withEnv } from "./test-utils/env.js";
import {
  VERSION,
  readBuildIdFromBuildInfoForModuleUrl,
  readBuildProvenanceForModuleUrl,
  resolveCompatibilityHostVersion,
  resolveBinaryVersion,
  resolveRuntimeServiceVersion,
  resolveUsableRuntimeVersion,
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

const sourcePackage = { name: "openclaw", version: "2" };
it.each([
  [{ "package.json": sourcePackage, "build-info.json": { version: "1" } }, "1"],
  [{ "package.json": sourcePackage }, "2"],
  [{ "package.json": { name: "other", version: "2" }, "build-info.json": { version: " " } }, "8"],
  [undefined, "8"],
  [undefined, "0.0.0", " "],
] as const)("resolves version precedence: %j", async (files, expected, bundled?: string) => {
  const moduleUrl = files ? await versionFixture(files) : "not-a-valid-url";
  expect(resolveBinaryVersion({ moduleUrl, bundledVersion: bundled ?? "8" })).toBe(expected);
});

it.each([
  { buildId: "build-a" },
  {
    buildId: "x".repeat(96),
    version: "2026.10.22",
    commit: "a".repeat(40),
    builtAt: "2026-10-22T00:00:00.000Z",
  },
])("captures the first usable build record: %j", async (record) => {
  const moduleUrl = await versionFixture({
    "dist/build-info.json": { buildId: "x".repeat(97) },
    "build-info.json": record,
  });
  expect(readBuildIdFromBuildInfoForModuleUrl(moduleUrl)).toBe(record.buildId);
  // Provenance names the file that actually supplied the ID, not the first candidate found.
  expect(readBuildProvenanceForModuleUrl(moduleUrl)).toEqual({
    ...record,
    buildInfoPath: await fs.realpath(fileURLToPath(new URL("../../build-info.json", moduleUrl))),
  });
});

it.each([undefined, " ", "x".repeat(97)])("rejects unusable build id %s", async (buildId) => {
  const moduleUrl = await versionFixture(
    buildId === undefined ? {} : { "build-info.json": { version: "1", buildId } },
  );
  expect(readBuildProvenanceForModuleUrl(moduleUrl)).toBeNull();
  expect(readBuildIdFromBuildInfoForModuleUrl(moduleUrl)).toBeNull();
});

it("captures the runtime commit from startup provenance once", async () => {
  let commit = "aaaaaaa";
  // mock-isolation: Pin startup provenance without probing the checkout or build environment.
  vi.doMock("./infra/git-commit.js", () => ({ resolveLoadedCommitHash: () => commit }));
  vi.resetModules();
  try {
    const runtimeVersion = await import("./version.js");
    expect(runtimeVersion.resolveRuntimeServiceCommit()).toBe("aaaaaaa");
    commit = "bbbbbbb";
    expect(runtimeVersion.resolveRuntimeServiceCommit()).toBe("aaaaaaa");
  } finally {
    vi.doUnmock("./infra/git-commit.js");
    vi.resetModules();
  }
});

it.each([
  [true, undefined, VERSION],
  [false, undefined, "2026.3.99"],
  [false, "2026.4.8", "2026.4.8"],
] as const)("selects compatibility version (%s, %s)", (useProcess, override, expected) => {
  const env = {
    OPENCLAW_COMPATIBILITY_HOST_VERSION: override,
    OPENCLAW_VERSION: "2026.3.99",
    npm_package_version: "2026.3.97",
  };
  withEnv(env, () =>
    expect(resolveCompatibilityHostVersion(useProcess ? undefined : env)).toBe(expected),
  );
});

it("normalizes runtime version candidate for fallback handling", () => {
  const inputs = [undefined, " \t ", " 0.0.0 ", " 2026.3.2 "];
  const versions = inputs.map(resolveUsableRuntimeVersion);
  expect(versions).toEqual([undefined, undefined, undefined, "2026.3.2"]);
});

it("prefers runtime VERSION over package markers and ignores unusable env values", () => {
  const resolve = (OPENCLAW_VERSION: string, npm_package_version: string, fallback?: string) =>
    resolveRuntimeServiceVersion({ OPENCLAW_VERSION, npm_package_version }, fallback);
  expect(resolve("   ", "1.0.0", "fallback")).toBe(VERSION);
  expect(resolve("undefined", "1.0.0-package")).toBe(VERSION);
});
