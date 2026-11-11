import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir as generationDir,
  resolvePluginNpmProjectDir,
  resolvePluginNpmProjectsDir,
} from "./install-paths.js";
import { loadInstalledPluginIndexInstallRecordsSync as readInstallRecords } from "./installed-plugin-index-record-reader.js";
import { listManagedPluginNpmRootsForInstallRecords } from "./installed-plugin-npm-roots.js";
import { listManagedPluginNpmRootsSync } from "./npm-project-roots.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let stateDir: string;
let npmRoot: string;
let projectsDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-npm-project-roots-");
  npmRoot = path.join(stateDir, "npm");
  projectsDir = resolvePluginNpmProjectsDir(npmRoot);
});

function writePlugin(packageName: string, layout?: "legacy", version = "1.0.0") {
  const pluginId = path.posix.basename(packageName);
  return writeManagedNpmPlugin({ stateDir, packageName, pluginId, version, layout });
}

function readRecords() {
  return withPluginCache(createPluginCache(), () => readInstallRecords({ stateDir }));
}

function projectDir(packageName: string) {
  return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
}
afterEach(() => vi.restoreAllMocks());

it("selects and deduplicates managed record paths, including legacy and scoped packages", () => {
  const legacy = writePlugin("legacy", "legacy");
  const scoped = writePlugin("@fixture/scoped");
  const projectRoot = projectDir("@fixture/scoped");
  writePlugin("zulu");
  fs.writeFileSync(path.join(projectsDir, "metadata.json"), "{}");
  expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([
    npmRoot,
    ...[projectRoot, projectDir("zulu")].toSorted((a, b) => a.localeCompare(b)),
  ]);
  expect(
    listManagedPluginNpmRootsForInstallRecords({
      npmRoot,
      installRecords: {
        legacy: { source: "npm", installPath: legacy },
        scoped: { source: "npm", installPath: scoped },
        duplicate: { source: "npm", installPath: scoped },
        developer: { source: "path", installPath: scoped },
        external: {
          source: "npm",
          installPath: path.join(stateDir, "external", "node_modules", "other"),
        },
        absent: { source: "npm" },
      },
    }),
  ).toEqual([npmRoot, projectRoot].toSorted((left, right) => left.localeCompare(right)));
});

it("does not discover stale roots for empty records and warns before unreadable-record fallback", () => {
  writePlugin("stale");
  const reads = vi.spyOn(fs, "readdirSync");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  expect(listManagedPluginNpmRootsForInstallRecords({ npmRoot, installRecords: {} })).toEqual([]);
  expect(reads).not.toHaveBeenCalled();
  expect(warning).not.toHaveBeenCalled();
  expect(listManagedPluginNpmRootsForInstallRecords({ npmRoot, installRecords: null })).toEqual([
    npmRoot,
    projectDir("stale"),
  ]);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("could not be read"), {
    code: "OPENCLAW_PLUGIN_NPM_ROOTS_FALLBACK",
  });
});

it.each(["flat", "generation"] as const)("recovers bytes from published %s projects", (layout) => {
  const packageName = "@fixture/published";
  const packageDir = writePlugin(packageName);
  const flatRoot = projectDir(packageName);
  const stageRoot = path.join(projectsDir, ".openclaw-install-stage-fixture");
  const packageRelative = path.relative(flatRoot, packageDir);
  const readBytes = (root: string) =>
    fs.readFileSync(path.join(root, packageRelative, "package.json"));
  const packageBytes = fs.readFileSync(path.join(packageDir, "package.json"));
  fs.renameSync(flatRoot, stageRoot);
  expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
  expect(readRecords()).toEqual({});
  expect(readBytes(stageRoot)).toEqual(packageBytes);

  const publishedRoot =
    layout === "flat"
      ? flatRoot
      : generationDir({ npmDir: npmRoot, packageName, generationKey: "published-1.0.0" });
  fs.renameSync(stageRoot, publishedRoot);
  expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot, publishedRoot]);
  const records = readRecords();
  expect(Object.keys(records)).toEqual(["published"]);
  expect(records.published?.installPath).toBe(path.join(publishedRoot, packageRelative));
  expect(readBytes(publishedRoot)).toEqual(packageBytes);
});

it("retains legacy recovery and excludes complete custody directories and substituted projects", () => {
  const packageName = "@fixture/custody";
  const packageDir = writePlugin(packageName);
  const projectRoot = projectDir(packageName);
  for (const name of [
    ".openclaw-install-backup-fixture",
    "_openclaw-quarantined-npm-projects",
    "arbitrary",
  ]) {
    fs.cpSync(projectRoot, path.join(projectsDir, name), { recursive: true });
  }
  const outside = path.join(stateDir, "outside-project");
  fs.renameSync(projectRoot, outside);
  fs.symlinkSync(outside, projectRoot, "junction");
  const legacyDir = writePlugin("legacy", "legacy", "2.0.0");
  expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
  const records = readRecords();
  expect(Object.keys(records)).toEqual(["legacy"]);
  expect(records.legacy?.installPath).toBe(legacyDir);
  expect(fs.existsSync(path.join(outside, path.relative(projectRoot, packageDir)))).toBe(true);
});

it.each(["missing", "file"])("treats a %s projects path as unavailable", (kind) => {
  if (kind === "file") {
    fs.mkdirSync(npmRoot, { recursive: true });
    fs.writeFileSync(projectsDir, "not a directory", "utf8");
  }
  expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
});

it("propagates unrelated filesystem errors", () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
    throw error;
  });
  expect(() => listManagedPluginNpmRootsSync("/fake/npm")).toThrow(error);
});
