import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type PackageManifest } from "../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../plugins/package-entry-resolution.js";
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

async function readInstalledPackageJson(
  rootDir: string,
  packageJsonRelPath: string,
): Promise<PackageManifest> {
  const absPath = path.join(rootDir, packageJsonRelPath);
  const raw = await fs.readFile(absPath, "utf-8");
  return JSON.parse(raw) as PackageManifest;
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
    if (!record.enabled) {
      continue;
    }
    const pkgRelPath = record.packageJson?.path ?? "package.json";
    let pkg: PackageManifest;
    try {
      pkg = await readInstalledPackageJson(record.rootDir, pkgRelPath);
    } catch (err) {
      process.stderr.write(
        `[doctor-post-upgrade] could not read package.json for ${record.pluginId} at ${record.rootDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    const entries = pkg.openclaw?.extensions ?? [];
    if (entries.length > 0) {
      // Delegate to the install-time resolver so the probe enforces the same
      // contract as plugin install/discovery: runtimeExtensions shape, plugin-root
      // boundary, and inferred-built-output / TypeScript-source-only handling.
      const validation = await validatePackageExtensionEntriesForInstall({
        packageDir: record.rootDir,
        extensions: [...entries],
        manifest: pkg,
      });
      if (!validation.ok) {
        const offendingEntry = entries.find((entry) => validation.error.includes(entry));
        findings.push({
          level: "error",
          code: "plugin.entry_unresolved",
          message: `Plugin ${record.pluginId}: ${validation.error}`,
          plugin: record.pluginId,
          ...(offendingEntry ? { entry: offendingEntry } : {}),
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
