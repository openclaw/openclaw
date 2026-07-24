// Guards the compact startup projection and its parity with externalized provider manifests.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import rootPackageJson from "../../package.json" with { type: "json" };
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  applyOfficialExternalPluginManifestCompatibility,
  hasOfficialExternalChannelTarget,
  hasOfficialExternalContractTarget,
  hasOfficialExternalProviderTarget,
  hasOfficialExternalWebContractEnvTarget,
  hasOfficialExternalWebSearchTarget,
  isOfficialExternalPluginId,
  listOfficialExternalChannelEnvVars,
  listOfficialExternalProviderEndpoints,
  listOfficialExternalWebSearchProviderOwners,
  resolveOfficialExternalPluginInstallHint,
  resolveOfficialExternalPluginPackageOwnership,
} from "./official-external-plugin-startup-metadata.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

type ExtensionManifestRecord = {
  dirName: string;
  manifest: Record<string, unknown>;
};

function listExtensionManifests(): ExtensionManifestRecord[] {
  const extensionsDir = path.join(repoRoot, "extensions");
  const records: ExtensionManifestRecord[] = [];
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extensionsDir, entry.name, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const manifest = parseJsonWithJson5Fallback(fs.readFileSync(manifestPath, "utf8"));
    if (isRecord(manifest)) {
      records.push({ dirName: entry.name, manifest });
    }
  }
  return records;
}

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

describe("official external plugin startup metadata", () => {
  it("resolves canonical ownership, aliases, and preferred install hints", () => {
    expect(isOfficialExternalPluginId("QWEN")).toBe(true);
    expect(isOfficialExternalPluginId("modelstudio")).toBe(false);
    expect(resolveOfficialExternalPluginInstallHint("modelstudio")).toBe("@openclaw/qwen-provider");
    expect(resolveOfficialExternalPluginInstallHint("lark")).toBe("@openclaw/feishu");
    expect(resolveOfficialExternalPluginInstallHint("yuanbao")).toBe(
      "openclaw-plugin-yuanbao@2.15.0",
    );
    expect(resolveOfficialExternalPluginPackageOwnership("@openclaw/qwen-provider")).toEqual({
      pluginId: "qwen",
      source: "official",
      npmSpec: "@openclaw/qwen-provider",
    });
  });

  it("restores manifest-registry compatibility with manifest-owned values winning", () => {
    expect(
      applyOfficialExternalPluginManifestCompatibility({
        packageName: "@openclaw/firecrawl-plugin",
        catalog: undefined,
        contracts: { tools: ["manifest_tool"] },
        channelConfigs: undefined,
      }).contracts,
    ).toEqual({
      tools: ["manifest_tool", "firecrawl_search", "firecrawl_scrape"],
      webFetchProviders: ["firecrawl"],
      webSearchProviders: ["firecrawl", "firecrawl-free"],
    });

    expect(
      applyOfficialExternalPluginManifestCompatibility({
        packageName: "@openclaw/diffs",
        catalog: { featured: false },
        contracts: undefined,
        channelConfigs: undefined,
      }).catalog,
    ).toEqual({ featured: false, order: 40 });

    const compatibility = applyOfficialExternalPluginManifestCompatibility({
      packageName: "@wecom/wecom-openclaw-plugin",
      catalog: undefined,
      contracts: undefined,
      channelConfigs: {
        wecom: {
          label: "Manifest WeCom",
          schema: { type: "object", additionalProperties: false },
          uiHints: { corpId: { label: "Manifest Corp ID" } },
        },
      },
    });
    expect(compatibility.contracts?.tools).toEqual(["wecom_mcp"]);
    expect(compatibility.channelConfigs?.wecom).toMatchObject({
      label: "Manifest WeCom",
      description: "Enterprise WeChat conversation channel.",
      schema: { type: "object", additionalProperties: false },
      uiHints: { corpId: { label: "Manifest Corp ID" } },
    });
  });

  it("exposes startup target signals without the full catalog runtime", () => {
    expect(hasOfficialExternalProviderTarget({ providerIds: ["gmi-cloud"], env: {} })).toBe(true);
    expect(
      hasOfficialExternalProviderTarget({ providerIds: [], env: { GROQ_API_KEY: "key" } }),
    ).toBe(true);
    expect(
      hasOfficialExternalContractTarget({
        contract: "memoryEmbeddingProviders",
        providerIds: ["deepinfra"],
      }),
    ).toBe(true);
    expect(
      hasOfficialExternalWebContractEnvTarget({
        contract: "webFetchProviders",
        env: { FIRECRAWL_API_KEY: "key" },
      }),
    ).toBe(true);
    expect(
      hasOfficialExternalChannelTarget({
        config: { channels: { mattermost: { enabled: true } } },
        env: {},
      }),
    ).toBe(true);
    expect(hasOfficialExternalWebSearchTarget({ providerId: "exa", env: {} })).toBe(true);
    expect(listOfficialExternalChannelEnvVars()).toContainEqual({
      channelId: "mattermost",
      envVars: ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"],
    });
    expect(listOfficialExternalWebSearchProviderOwners()).toContainEqual({
      providerId: "exa",
      pluginId: "exa",
    });
  });
});

describe("official external provider endpoint startup projection", () => {
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
      expect(
        catalogManifest,
        `extensions/${dirName} is excluded from dist and declares providerEndpoints; ` +
          `official-external-provider-catalog.json needs an entry for plugin "${pluginId}"`,
      ).toBeDefined();
      expect(catalogManifest?.providerEndpoints).toEqual(manifest.providerEndpoints);
      if (pluginId) {
        checkedPluginIds.push(pluginId);
      }
    }
    expect(checkedPluginIds).toContain("qwen");
    expect(checkedPluginIds).toContain("moonshot");
  });

  it("keeps catalog providerEndpoints in sync with local plugin manifests", () => {
    const extensionManifestsById = new Map(
      extensionManifests
        .filter((record) => typeof record.manifest.id === "string")
        .map((record) => [record.manifest.id as string, record]),
    );
    for (const [pluginId, catalogManifest] of catalogManifestsByPluginId) {
      if (catalogManifest.providerEndpoints === undefined) {
        continue;
      }
      const local = extensionManifestsById.get(pluginId);
      if (local) {
        expect(catalogManifest.providerEndpoints).toEqual(local.manifest.providerEndpoints);
      }
    }
  });

  it("exposes endpoint metadata for externalized providers", () => {
    const endpointClasses = listOfficialExternalProviderEndpoints().map(
      (endpoint) => endpoint.endpointClass,
    );
    expect(endpointClasses).toContain("modelstudio-native");
    expect(endpointClasses).toContain("moonshot-native");
    expect(endpointClasses).toContain("meta-native");
    expect(endpointClasses).toContain("zai-native");
  });
});
