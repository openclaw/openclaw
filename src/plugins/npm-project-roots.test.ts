import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
  resolvePluginNpmProjectsDir,
} from "./install-paths.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { listManagedPluginNpmRootsForInstallRecords } from "./installed-plugin-npm-roots.js";
import { listManagedPluginNpmRootsSync } from "./npm-project-roots.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let stateDir: string;
let npmRoot: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-npm-project-roots-");
  npmRoot = path.join(stateDir, "npm");
});

function writePlugin(
  packageName: string,
  options: { pluginId?: string; version?: string; layout?: "legacy" } = {},
) {
  return writeManagedNpmPlugin({
    stateDir,
    packageName,
    pluginId: options.pluginId ?? packageName,
    version: "1.0.0",
    ...options,
  });
}

function readRecords() {
  return withPluginCache(createPluginCache(), () =>
    loadInstalledPluginIndexInstallRecordsSync({ stateDir }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed npm project roots", () => {
  it("selects and deduplicates managed record paths, including legacy and scoped packages", () => {
    const legacy = writePlugin("legacy", { layout: "legacy" });
    const scoped = writePlugin("@fixture/scoped", { pluginId: "scoped" });
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir: npmRoot,
      packageName: "@fixture/scoped",
    });
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
      resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName: "stale" }),
    ]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("could not be read"), {
      code: "OPENCLAW_PLUGIN_NPM_ROOTS_FALLBACK",
    });
  });

  it("returns sorted canonical project directories and skips files", () => {
    const projects = ["zulu", "alpha"]
      .map((packageName) => {
        writePlugin(packageName);
        return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      })
      .toSorted((left, right) => left.localeCompare(right));
    fs.writeFileSync(path.join(resolvePluginNpmProjectsDir(npmRoot), "metadata.json"), "{}");

    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot, ...projects]);
  });

  it.each(["flat", "generation"] as const)(
    "recovers identical package bytes only after publication into a %s project",
    (layout) => {
      const packageName = "@fixture/published";
      const packageDir = writePlugin(packageName, { pluginId: "published" });
      const flatRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      const stageRoot = path.join(
        resolvePluginNpmProjectsDir(npmRoot),
        ".openclaw-install-stage-fixture",
      );
      const packageRelative = path.relative(flatRoot, packageDir);
      const packageBytes = fs.readFileSync(path.join(packageDir, "package.json"));
      fs.renameSync(flatRoot, stageRoot);
      expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
      expect(readRecords()).toEqual({});
      expect(fs.readFileSync(path.join(stageRoot, packageRelative, "package.json"))).toEqual(
        packageBytes,
      );

      const publishedRoot =
        layout === "flat"
          ? flatRoot
          : resolvePluginNpmGenerationProjectDir({
              npmDir: npmRoot,
              packageName,
              generationKey: "published-1.0.0",
            });
      fs.renameSync(stageRoot, publishedRoot);
      expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot, publishedRoot]);
      expect(readRecords()).toEqual({
        published: {
          source: "npm",
          spec: "@fixture/published@1.0.0",
          installPath: path.join(publishedRoot, packageRelative),
          version: "1.0.0",
          resolvedName: packageName,
          resolvedVersion: "1.0.0",
          resolvedSpec: "@fixture/published@1.0.0",
        },
      });
      expect(fs.readFileSync(path.join(publishedRoot, packageRelative, "package.json"))).toEqual(
        packageBytes,
      );
    },
  );

  it("retains legacy recovery and excludes complete custody directories and substituted projects", () => {
    const packageName = "@fixture/custody";
    const packageDir = writePlugin(packageName, { pluginId: "custody" });
    const projectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
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
    const legacyDir = writePlugin("legacy", { version: "2.0.0", layout: "legacy" });
    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
    const records = readRecords();
    expect(Object.keys(records)).toEqual(["legacy"]);
    expect(records.legacy?.installPath).toBe(legacyDir);
    expect(fs.existsSync(path.join(outside, path.relative(projectRoot, packageDir)))).toBe(true);
  });

  it("treats a missing projects directory as empty", () => {
    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
  });

  it("treats a projects path that is a file as unavailable", () => {
    fs.mkdirSync(npmRoot, { recursive: true });
    fs.writeFileSync(resolvePluginNpmProjectsDir(npmRoot), "not a directory", "utf8");

    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
  });

  it("propagates unrelated filesystem errors", () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw error;
    });
    expect(() => listManagedPluginNpmRootsSync("/fake/npm")).toThrow(error);
  });
});
