import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeJsonFile } from "../../test/helpers/temp-repo.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { listStaleLocalBundledPluginInstallRecords } from "./stale-local-bundled-plugin-install-records.js";
import { writeCohortPackage } from "./update-cohort.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const root = fs.realpathSync(tempDirs.make("bundled-record-owner-"));
  const current = path.join(root, "current");
  const previous = path.join(root, "previous");
  for (const packageRoot of [current, previous]) {
    writeJsonFile(path.join(packageRoot, "package.json"), { name: "openclaw" });
    writeCohortPackage(path.join(packageRoot, "dist", "extensions", "probe"), "probe");
  }
  vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(`${current}/`).href);
  const currentPath = path.join(current, "dist", "extensions", "probe");
  return {
    root,
    current,
    previous,
    currentPath,
    previousPath: path.join(previous, "dist", "extensions", "probe"),
    bundled: new Map([
      ["probe", { pluginId: "probe", localPath: currentPath, version: "2026.11.10" }],
    ]),
  };
}

it.each([undefined, "2026.11.10", "2026.11.9"])(
  "lists a foreign compiled bundle independently of its recorded version (%s)",
  (version) => {
    const { bundled, previousPath, currentPath } = fixture();
    const record: PluginInstallRecord = { source: "path", installPath: previousPath, version };
    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: { probe: record },
        bundled,
        env: {},
      }),
    ).toEqual([{ pluginId: "probe", record, stalePath: previousPath, bundledPath: currentPath }]);
  },
);

it.each(["current", "source", "external", "lookalike", "missing", "npm", "dev-source"])(
  "does not retire an unproven or selected source (%s)",
  (kind) => {
    const { root, currentPath, previous, previousPath, bundled } = fixture();
    let installPath = previousPath;
    if (kind === "current") {
      installPath = currentPath;
    } else if (kind === "source" || kind === "external") {
      installPath = path.join(root, kind === "source" ? "extensions" : "custom", "probe");
      writeCohortPackage(installPath, "probe");
    } else if (kind === "lookalike") {
      writeJsonFile(path.join(previous, "package.json"), { name: "not-openclaw" });
    } else if (kind === "missing") {
      fs.rmSync(previous, { recursive: true });
    } else if (kind === "dev-source") {
      writeJsonFile(path.join(previous, "package.json"), { name: "openclaw" });
      fs.mkdirSync(path.join(previous, "src"));
      fs.mkdirSync(path.join(previous, "extensions"));
      fs.writeFileSync(path.join(previous, "pnpm-workspace.yaml"), "packages: [extensions/*]\n");
    }
    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          probe: { source: kind === "npm" ? "npm" : "path", installPath, version: "2026.11.9" },
        },
        bundled,
        env: kind === "dev-source" ? { OPENCLAW_DEV_SOURCE_ROOT: previous } : {},
      }),
    ).toEqual([]);
  },
);
