import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import {
  clearLoadInstalledPluginIndexInstallRecordsCache,
  loadInstalledPluginIndexInstallRecords as readAsync,
  loadInstalledPluginIndexInstallRecordsSync as readSync,
} from "./installed-plugin-index-records.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = createTempDirTracker();
type Counts = { opens: number; reads: number };

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearLoadInstalledPluginIndexInstallRecordsCache();
  tempDirs.cleanup();
});

it.each([
  ["project", "async"],
  ["project", "sync"],
  ["legacy", "async"],
  ["legacy", "sync"],
] as const)("reads managed npm manifests once during %s %s recovery", async (layout, mode) => {
  const stateDir = tempDirs.make("openclaw-plugin-index-records-");
  const packageName = "@fixture/install-key";
  const packageDir = writeManagedNpmPlugin({
    stateDir,
    packageName,
    pluginId: "fixture-plugin",
    version: "1.2.3",
    dependencySpec: "latest",
    layout,
  });
  const packagePath = path.join(packageDir, "package.json");
  fs.writeFileSync(
    packagePath,
    JSON.stringify({
      name: "@fixture/package-name",
      version: " 1.2.3 ",
      openclaw: { extensions: ["./dist/index.js"] },
    }),
  );
  const projectRoot =
    layout === "legacy"
      ? path.join(stateDir, "npm")
      : resolvePluginNpmProjectDir({ npmDir: path.join(stateDir, "npm"), packageName });
  const counts = new Map<string, Counts>(
    [
      packagePath,
      path.join(packageDir, "openclaw.plugin.json"),
      path.join(projectRoot, "package.json"),
    ].map((file) => [file, { opens: 0, reads: 0 }]),
  );
  const descriptors = new Map<number, { counts: Counts; start: number }>();
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  clearLoadInstalledPluginIndexInstallRecordsCache();
  const readFile = vi.spyOn(fs, "readFileSync");
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, permissions) => {
    const fd = originalOpen(file, flags, permissions);
    const fileCounts = counts.get(String(file));
    if (fileCounts) {
      fileCounts.opens++;
      descriptors.set(fd, { counts: fileCounts, start: readFile.mock.calls.length });
    }
    return fd;
  });
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    const tracked = descriptors.get(fd);
    if (tracked) {
      tracked.counts.reads += readFile.mock.calls
        .slice(tracked.start)
        .filter(([file]) => file === fd).length;
      descriptors.delete(fd);
    }
    return originalClose(fd);
  });
  const read = mode === "async" ? readAsync : readSync;
  const expected = {
    "fixture-plugin": {
      source: "npm",
      spec: `${packageName}@latest`,
      installPath: packageDir,
      version: "1.2.3",
      resolvedName: packageName,
      resolvedVersion: "1.2.3",
      resolvedSpec: `${packageName}@1.2.3`,
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await read({ stateDir })).toEqual(expected);
    expect(descriptors.size).toBe(0);
    for (const [file, observed] of counts) {
      expect(observed, file).toEqual({ opens: 1, reads: 1 });
    }
  }
});
