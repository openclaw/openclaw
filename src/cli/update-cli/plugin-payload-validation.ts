// Static payload checks for installed plugins after a core update swaps package files.
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  CODEX_BUNDLE_MANIFEST_RELATIVE_PATH,
  CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH,
  detectBundleManifestFormat,
  loadBundleManifest,
} from "../../plugins/bundle-manifest.js";
import type { PluginBundleFormat } from "../../plugins/manifest-types.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "../../plugins/manifest.js";
import { validatePackageExtensionEntriesForInstall } from "../../plugins/package-entry-resolution.js";
import { auditOpenClawPeerDependencyLink } from "../../plugins/plugin-peer-link.js";
import { resolveUserPath } from "../../utils.js";

export type PluginPayloadSmokeFailureReason =
  | "missing-install-path"
  | "missing-package-dir"
  | "missing-bundle-manifest"
  | "invalid-bundle-manifest"
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

    const packageJsonPath = path.join(installPath, "package.json");
    const packageJsonStat = await safeStat(packageJsonPath);
    if (!packageJsonStat?.isFile()) {
      const bundleFormat = await resolveBundlePayloadFormat({ installPath, record });
      if (bundleFormat) {
        const bundleValidation = validateBundlePayload({ installPath, bundleFormat });
        if (bundleValidation) {
          failures.push({
            pluginId,
            installPath,
            reason: bundleValidation.reason,
            detail: bundleValidation.detail,
          });
        }
        continue;
      }
      if (isBundleInstallRecord(record)) {
        failures.push({
          pluginId,
          installPath,
          reason: "missing-bundle-manifest",
          detail: `Bundle manifest is missing under ${installPath}`,
        });
        continue;
      }
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

function isBundleInstallRecord(record: PluginInstallRecord): boolean {
  return (
    (record as { format?: unknown }).format === "bundle" || record.clawhubFamily === "bundle-plugin"
  );
}

function readBundleFormat(record: PluginInstallRecord): PluginBundleFormat | null {
  const raw = (record as { bundleFormat?: unknown }).bundleFormat;
  return raw === "codex" || raw === "claude" || raw === "cursor" ? raw : null;
}

async function detectExplicitBundleManifestFormat(
  installPath: string,
): Promise<PluginBundleFormat | null> {
  const codexManifest = await safeStat(path.join(installPath, CODEX_BUNDLE_MANIFEST_RELATIVE_PATH));
  if (codexManifest?.isFile()) {
    return "codex";
  }
  const cursorManifest = await safeStat(
    path.join(installPath, CURSOR_BUNDLE_MANIFEST_RELATIVE_PATH),
  );
  if (cursorManifest?.isFile()) {
    return "cursor";
  }
  const claudeManifest = await safeStat(
    path.join(installPath, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH),
  );
  return claudeManifest?.isFile() ? "claude" : null;
}

async function resolveBundlePayloadFormat(params: {
  installPath: string;
  record: PluginInstallRecord;
}): Promise<PluginBundleFormat | null> {
  const explicitManifestFormat = await detectExplicitBundleManifestFormat(params.installPath);
  if (explicitManifestFormat) {
    return explicitManifestFormat;
  }
  if (!isBundleInstallRecord(params.record)) {
    return null;
  }
  return detectBundleManifestFormat(params.installPath) ?? readBundleFormat(params.record);
}

function validateBundlePayload(params: {
  installPath: string;
  bundleFormat: PluginBundleFormat;
}): Pick<PluginPayloadSmokeFailure, "reason" | "detail"> | null {
  const loaded = loadBundleManifest({
    rootDir: params.installPath,
    bundleFormat: params.bundleFormat,
  });
  if (!loaded.ok) {
    return {
      reason: "invalid-bundle-manifest",
      detail: loaded.error,
    };
  }
  if (loaded.manifest.capabilities.length === 0) {
    return {
      reason: "invalid-bundle-manifest",
      detail: `Bundle manifest has no supported capabilities under ${params.installPath}`,
    };
  }
  return null;
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
