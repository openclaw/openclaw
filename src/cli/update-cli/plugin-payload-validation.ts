// Static payload checks for installed plugins after a core update swaps package files.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { detectBundleManifestFormat, loadBundleManifest } from "../../plugins/bundle-manifest.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "../../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../../plugins/package-entry-resolution.js";
import { auditOpenClawPeerDependencyLink } from "../../plugins/plugin-peer-link.js";
import { resolveUserPath } from "../../utils.js";

export type PluginPayloadSmokeFailureReason =
  | "missing-install-path"
  | "missing-package-dir"
  | "missing-package-json"
  | "invalid-package-json"
  | "missing-main-entry"
  | "missing-extension-entry"
  | "missing-openclaw-peer-link";

export type PluginPayloadSmokeFailure = {
  pluginId: string;
  installPath?: string;
  reason: PluginPayloadSmokeFailureReason;
  detail: string;
};

export type PluginPayloadSmokeResult = {
  checked: string[];
  failures: PluginPayloadSmokeFailure[];
};

const TRACKED_SOURCES: ReadonlySet<string> = new Set(["npm", "clawhub", "git", "marketplace"]);

/**
 * Bundle plugins (format=bundle, e.g. Claude-plugin layout with
 * `.claude-plugin/plugin.json` and no top-level `package.json`) are
 * tracked by ClawHub but use a different manifest structure than npm
 * packages.  The smoke check must recognize them so it does not
 * false-fail on the missing `package.json`.
 */
function isBundlePluginRecord(record: PluginInstallRecord): boolean {
  return (record as { clawhubFamily?: string }).clawhubFamily === "bundle-plugin";
}

/**
 * Verify that each tracked plugin install record on disk is structurally
 * loadable: the install dir exists, contains a parseable `package.json`,
 * and any declared package entry files exist.
 *
 * IMPORTANT: this is intentionally a *static* check. We do NOT execute the
 * plugin's code, so post-update side effects (network calls, filesystem
 * writes, registry registration) cannot fire while the gateway is still
 * stopped. The goal is to catch obvious payload corruption — missing files,
 * unparseable manifests — before we hand control back to the restart path.
 */
export async function runPluginPayloadSmokeCheck(params: {
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
}): Promise<PluginPayloadSmokeResult> {
  const checked: string[] = [];
  const failures: PluginPayloadSmokeFailure[] = [];

  for (const [pluginId, record] of Object.entries(params.records).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!record || typeof record !== "object" || !TRACKED_SOURCES.has(record.source)) {
      continue;
    }
    const rawInstallPath = typeof record.installPath === "string" ? record.installPath.trim() : "";
    if (!rawInstallPath) {
      checked.push(pluginId);
      failures.push({
        pluginId,
        reason: "missing-install-path",
        detail: "Install path is missing from the plugin install record.",
      });
      continue;
    }
    const installPath = resolveUserPath(rawInstallPath, params.env);
    checked.push(pluginId);

    const dirStat = await safeStat(installPath);
    if (!dirStat?.isDirectory()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-package-dir",
        detail: `Install dir is missing: ${installPath}`,
      });
      continue;
    }

    // Preserve native-first payload classification: if a bundle-family
    // install record also has a top-level package.json, validate it as a
    // native package.  Dual-format directories (native package metadata
    // plus bundle markers) use the native path per the bundle docs.
    const nativePackageJson = await safeStat(path.join(installPath, "package.json"));
    if (isBundlePluginRecord(record) && !nativePackageJson?.isFile()) {
      // Bundle plugins use manifest files (`.claude-plugin/plugin.json`,
      // `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, or
      // manifestless Claude markers) instead of `package.json`.  Use the
      // shared bundle detector/loader to cover all supported formats.
      const bundleFormat = detectBundleManifestFormat(installPath);
      if (bundleFormat === null) {
        failures.push({
          pluginId,
          installPath,
          reason: "missing-package-json",
          detail: `Bundle plugin manifest is missing under ${installPath}`,
        });
        continue;
      }
      const loaded = loadBundleManifest({ rootDir: installPath, bundleFormat });
      if (!loaded.ok) {
        failures.push({
          pluginId,
          installPath,
          reason: "invalid-package-json",
          detail: `Could not load bundle plugin manifest: ${loaded.error}`,
        });
      }
      continue;
    }

    const packageJsonPath = path.join(installPath, "package.json");
    const packageJsonStat = await safeStat(packageJsonPath);
    if (!packageJsonStat?.isFile()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-package-json",
        detail: `package.json is missing under ${installPath}`,
      });
      continue;
    }

    let manifest: PackageManifest & { main?: unknown; exports?: unknown };
    try {
      manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as typeof manifest;
    } catch (err) {
      failures.push({
        pluginId,
        installPath,
        reason: "invalid-package-json",
        detail: `Could not parse package.json: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (manifestDeclaresOpenClawPeer(manifest)) {
      const peerIssue = await auditOpenClawPeerDependencyLink({
        packageDir: installPath,
        packageName: manifest.name ?? pluginId,
      });
      if (peerIssue) {
        failures.push({
          pluginId,
          installPath,
          reason: "missing-openclaw-peer-link",
          detail: `Plugin declares peerDependency "openclaw" but peer link audit failed: ${peerIssue.reason}.`,
        });
      }
    }

    const extensionResolution = resolvePackageExtensionEntries(manifest);
    if (extensionResolution.status === "invalid" || extensionResolution.status === "empty") {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-extension-entry",
        detail: `Plugin extension entry validation failed: ${
          extensionResolution.status === "invalid"
            ? extensionResolution.error
            : "package.json openclaw.extensions is empty"
        }`,
      });
      continue;
    } else if (extensionResolution.status === "ok") {
      const extensionValidation = await validatePackageExtensionEntriesForInstall({
        packageDir: installPath,
        extensions: extensionResolution.entries,
        manifest,
      });
      if (!extensionValidation.ok) {
        failures.push({
          pluginId,
          installPath,
          reason: "missing-extension-entry",
          detail: `Plugin extension entry validation failed: ${extensionValidation.error}`,
        });
      }
    }

    // Only fail on `missing-main-entry` when `main` is *explicitly declared*
    // and absent on disk. Fully resolving `exports` conditional sub-keys is
    // out of scope for a static smoke check, so packages with only `exports`
    // remain intentionally permissive.
    if (typeof manifest.main !== "string" || !manifest.main.trim()) {
      continue;
    }
    const mainRel = manifest.main.trim();
    const mainPath = path.join(installPath, mainRel);
    const mainStat = await safeStat(mainPath);
    if (!mainStat?.isFile()) {
      failures.push({
        pluginId,
        installPath,
        reason: "missing-main-entry",
        detail: `Plugin main entry "${mainRel}" not found at ${mainPath}`,
      });
    }
  }

  return { checked, failures };
}

function manifestDeclaresOpenClawPeer(manifest: PackageManifest): boolean {
  const peerDependencies = (manifest as { peerDependencies?: unknown }).peerDependencies;
  return (
    typeof peerDependencies === "object" &&
    peerDependencies !== null &&
    !Array.isArray(peerDependencies) &&
    typeof (peerDependencies as Record<string, unknown>).openclaw === "string"
  );
}

async function safeStat(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}
