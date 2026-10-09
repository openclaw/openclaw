import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmProjectDir,
  resolvePluginNpmProjectsDir,
} from "./install-paths.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { listManagedPluginNpmRootsSync, listManagedPluginNpmRoots } from "./npm-project-roots.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeNpmRoot(): string {
  const tempDir = tempDirs.make("openclaw-npm-project-roots-");
  return path.join(tempDir, "npm");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("managed npm project roots", () => {
  it("returns sorted canonical project directories and skips files", async () => {
    const npmRoot = makeNpmRoot();
    const projects = ["zulu", "alpha"]
      .map((packageName) => {
        writeManagedNpmPlugin({
          stateDir: path.dirname(npmRoot),
          packageName,
          pluginId: packageName,
          version: "1.0.0",
        });
        return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      })
      .toSorted((left, right) => left.localeCompare(right));
    fs.writeFileSync(path.join(resolvePluginNpmProjectsDir(npmRoot), "metadata.json"), "{}");

    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot, ...projects]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot, ...projects]);
  });

  it.each(["flat", "generation"] as const)(
    "recovers identical package bytes only after publication into a %s project",
    async (layout) => {
      const npmRoot = makeNpmRoot();
      const stateDir = path.dirname(npmRoot);
      const packageName = "@fixture/published";
      const packageDir = writeManagedNpmPlugin({
        stateDir,
        packageName,
        pluginId: "published",
        version: "1.0.0",
      });
      const flatRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      const stageRoot = path.join(
        resolvePluginNpmProjectsDir(npmRoot),
        ".openclaw-install-stage-fixture",
      );
      const packageRelative = path.relative(flatRoot, packageDir);
      const packageBytes = fs.readFileSync(path.join(packageDir, "package.json"));
      fs.renameSync(flatRoot, stageRoot);
      const readRecords = () =>
        withPluginCache(createPluginCache(), () =>
          loadInstalledPluginIndexInstallRecordsSync({ stateDir }),
        );
      expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
      await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot]);
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
      await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot, publishedRoot]);
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

  it("retains legacy recovery and excludes complete custody directories and substituted projects", async () => {
    const npmRoot = makeNpmRoot();
    const stateDir = path.dirname(npmRoot);
    const packageName = "@fixture/custody";
    const packageDir = writeManagedNpmPlugin({
      stateDir,
      packageName,
      pluginId: "custody",
      version: "1.0.0",
    });
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
    const legacyDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "legacy",
      pluginId: "legacy",
      version: "2.0.0",
      layout: "legacy",
    });
    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot]);
    const records = withPluginCache(createPluginCache(), () =>
      loadInstalledPluginIndexInstallRecordsSync({ stateDir }),
    );
    expect(Object.keys(records)).toEqual(["legacy"]);
    expect(records.legacy?.installPath).toBe(legacyDir);
    expect(fs.existsSync(path.join(outside, path.relative(projectRoot, packageDir)))).toBe(true);
  });

  it("treats a missing projects directory as empty", async () => {
    const npmRoot = makeNpmRoot();

    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot]);
  });

  it("treats a projects path that is a file as unavailable", async () => {
    const npmRoot = makeNpmRoot();
    fs.mkdirSync(npmRoot, { recursive: true });
    fs.writeFileSync(resolvePluginNpmProjectsDir(npmRoot), "not a directory", "utf8");

    expect(listManagedPluginNpmRootsSync(npmRoot)).toEqual([npmRoot]);
    await expect(listManagedPluginNpmRoots(npmRoot)).resolves.toEqual([npmRoot]);
  });

  it("propagates unrelated filesystem errors", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw error;
    });
    expect(() => listManagedPluginNpmRootsSync("/fake/npm")).toThrow(error);

    vi.spyOn(fs.promises, "readdir").mockRejectedValueOnce(error);
    await expect(listManagedPluginNpmRoots("/fake/npm")).rejects.toThrow(error);
  });
});
