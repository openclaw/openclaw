import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import rootPackageJson from "../../package.json" with { type: "json" };
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function listExtensionManifests() {
  const extensionsDir = path.join(repoRoot, "extensions");
  return fs.readdirSync(extensionsDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    const manifestPath = path.join(extensionsDir, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      return [];
    }
    const manifest = parseJsonWithJson5Fallback(fs.readFileSync(manifestPath, "utf8"));
    return isRecord(manifest) ? [{ dirName: entry.name, manifest }] : [];
  });
}

// Dist-excluded plugins are invisible to bundled discovery and need catalog mirrors.
const distExcludedExtensionDirs = new Set(
  (rootPackageJson.files ?? []).flatMap((entry) => {
    const match = /^!dist\/extensions\/([^/*]+)\/\*\*$/.exec(entry);
    return match?.[1] ? [match[1]] : [];
  }),
);

function listCatalogManifestsByPluginId(): Map<string, Record<string, unknown>> {
  const byPluginId = new Map<string, Record<string, unknown>>();
  for (const entry of officialExternalProviderCatalog.entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const manifest = entry.openclaw;
    if (!isRecord(manifest) || !isRecord(manifest.plugin)) {
      continue;
    }
    const pluginId = manifest.plugin.id;
    if (typeof pluginId === "string" && pluginId.trim()) {
      byPluginId.set(pluginId, manifest);
    }
  }
  return byPluginId;
}

function expectEndpoints(
  catalog: Record<string, unknown> | undefined,
  manifest: Record<string, unknown>,
  dirName: string,
) {
  expect(
    catalog?.providerEndpoints,
    `catalog must mirror extensions/${dirName}/openclaw.plugin.json`,
  ).toEqual(manifest.providerEndpoints);
}

describe("official external provider endpoint catalog mirror", () => {
  const extensionManifests = listExtensionManifests();
  const catalogManifestsByPluginId = listCatalogManifestsByPluginId();

  it("mirrors providerEndpoints for every dist-excluded plugin manifest that declares them", () => {
    const checkedPluginIds: string[] = [];
    for (const { dirName, manifest } of extensionManifests) {
      if (!Array.isArray(manifest.providerEndpoints) || !distExcludedExtensionDirs.has(dirName)) {
        continue;
      }
      const pluginId = typeof manifest.id === "string" ? manifest.id : undefined;
      const catalogManifest = pluginId ? catalogManifestsByPluginId.get(pluginId) : undefined;
      expectEndpoints(catalogManifest, manifest, dirName);
      if (pluginId) {
        checkedPluginIds.push(pluginId);
      }
    }
    // Keep the scan from passing vacuously.
    expect(checkedPluginIds).toContain("qwen");
    expect(checkedPluginIds).toContain("moonshot");
  });

  it("keeps catalog providerEndpoints in sync with local plugin manifests", () => {
    const extensionManifestsById = new Map(
      extensionManifests.map((record) => [record.manifest.id, record]),
    );
    for (const [pluginId, catalogManifest] of catalogManifestsByPluginId) {
      if (catalogManifest.providerEndpoints === undefined) {
        continue;
      }
      const local = extensionManifestsById.get(pluginId);
      if (local) {
        expectEndpoints(catalogManifest, local.manifest, local.dirName);
      }
    }
  });
});
