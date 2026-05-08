import fs from "node:fs/promises";
import path from "node:path";
import type { PostUpgradeFinding, PostUpgradeReport } from "./doctor-post-upgrade.types.js";

type InstalledPluginRecord = {
  pluginId: string;
  rootDir: string;
  enabled: boolean;
  packageJson?: { path: string };
};

type InstallsJson = { plugins: InstalledPluginRecord[] };

async function readInstalledPackageJson(rootDir: string, packageJsonRelPath: string) {
  const absPath = path.join(rootDir, packageJsonRelPath);
  const raw = await fs.readFile(absPath, "utf-8");
  return JSON.parse(raw) as { openclaw?: { extensions?: string[] } };
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
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
    const pkg = await readInstalledPackageJson(record.rootDir, pkgRelPath);
    const entries = pkg.openclaw?.extensions ?? [];
    for (const entry of entries) {
      const absEntry = path.resolve(record.rootDir, entry);
      if (!(await fileExists(absEntry))) {
        findings.push({
          level: "error",
          code: "plugin.entry_unresolved",
          message: `Plugin ${record.pluginId} declares extensions entry ${entry} but the file does not exist at ${absEntry}.`,
          plugin: record.pluginId,
          entry,
        });
      }
    }
  }

  return { probesRun: ["plugin.entry_unresolved"], findings };
}
