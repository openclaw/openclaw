import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listBuiltRuntimeEntryCandidates } from "../plugins/package-entrypoints.js";
import type { PostUpgradeFinding, PostUpgradeReport } from "./doctor-post-upgrade.types.js";

type InstalledPluginRecord = {
  pluginId: string;
  rootDir: string;
  enabled: boolean;
  packageJson?: { path: string };
  manifestPath?: string;
  manifestHash?: string;
};

type InstallsJson = { plugins: InstalledPluginRecord[] };

async function readInstalledPackageJson(rootDir: string, packageJsonRelPath: string) {
  const absPath = path.join(rootDir, packageJsonRelPath);
  const raw = await fs.readFile(absPath, "utf-8");
  return JSON.parse(raw) as { openclaw?: { extensions?: string[]; runtimeExtensions?: string[] } };
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function sha256OfFile(absPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(absPath);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export async function runPostUpgradeProbes(params: {
  installsPath: string;
}): Promise<PostUpgradeReport> {
  const findings: PostUpgradeFinding[] = [];
  const installsRaw = await fs.readFile(params.installsPath, "utf-8");
  const installs = JSON.parse(installsRaw) as InstallsJson;

  for (const record of installs.plugins) {
    if (!record.enabled) continue;
    const pkgRelPath = record.packageJson?.path ?? "package.json";
    let pkg: { openclaw?: { extensions?: string[]; runtimeExtensions?: string[] } };
    try {
      pkg = await readInstalledPackageJson(record.rootDir, pkgRelPath);
    } catch (err) {
      process.stderr.write(
        `[doctor-post-upgrade] could not read package.json for ${record.pluginId} at ${record.rootDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    const entries = pkg.openclaw?.extensions ?? [];
    const runtimeExtensions = pkg.openclaw?.runtimeExtensions ?? [];
    for (const [index, entry] of entries.entries()) {
      // First, check if there's an explicit runtimeExtensions entry at this index
      const runtimeEntry = runtimeExtensions[index];
      if (runtimeEntry) {
        const absRuntimeEntry = path.resolve(record.rootDir, runtimeEntry);
        if (await fileExists(absRuntimeEntry)) {
          // Runtime entry exists, so we're good; skip to next entry
          continue;
        }
        // Runtime entry doesn't exist; flag it
        findings.push({
          level: "error",
          code: "plugin.entry_unresolved",
          message: `Plugin ${record.pluginId} declares runtimeExtensions entry ${runtimeEntry} but the file does not exist at ${absRuntimeEntry}.`,
          plugin: record.pluginId,
          entry: runtimeEntry,
        });
        continue;
      }

      // No explicit runtime entry; try the source entry
      const absEntry = path.resolve(record.rootDir, entry);
      if (!(await fileExists(absEntry))) {
        // Source entry doesn't exist either; flag it
        findings.push({
          level: "error",
          code: "plugin.entry_unresolved",
          message: `Plugin ${record.pluginId} declares extensions entry ${entry} but the file does not exist at ${absEntry}.`,
          plugin: record.pluginId,
          entry,
        });
      }
    }

    if (record.manifestPath && record.manifestHash) {
      const currentHash = await sha256OfFile(record.manifestPath);
      if (currentHash && currentHash !== record.manifestHash) {
        findings.push({
          level: "warn",
          code: "plugin.manifest_drift",
          message: `Plugin ${record.pluginId} manifest hash drifted from installs.json snapshot. Run \`openclaw plugins registry --refresh\` to re-sync.`,
          plugin: record.pluginId,
        });
      }
    }
  }

  return { probesRun: ["plugin.entry_unresolved", "plugin.manifest_drift"], findings };
}
