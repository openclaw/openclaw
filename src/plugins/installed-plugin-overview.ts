import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { validatePluginUiCapabilities } from "../../packages/gateway-protocol/src/plugin-ui-capabilities.js";
import type {
  PluginDeclaredSurface,
  PluginOverviewCapabilities,
  PluginsInspectResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { parsePluginCacheJson, readPluginCacheFile } from "./plugin-cache-files.js";

/** Project a selected manifest's summary, never its package-wide consent union. */
export function projectPluginOverviewCapabilities(
  declared: Pick<PluginDeclaredSurface, "providers" | "channels" | "contracts">,
  uiCapabilities?: unknown,
): PluginOverviewCapabilities {
  const contracts: PluginOverviewCapabilities["contracts"] = {};
  for (const contract of declared.contracts) {
    const separator = contract.indexOf(": ");
    (contracts[contract.slice(0, separator)] ??= []).push(contract.slice(separator + 2));
  }
  const ui = validatePluginUiCapabilities(uiCapabilities);
  if (!ui.ok) {
    throw new Error(`Invalid plugin uiCapabilities: ${ui.error}`);
  }
  return {
    providers: declared.providers,
    channels: declared.channels,
    contracts,
    ...(ui.capabilities !== undefined ? { ui: ui.capabilities } : {}),
  };
}

/** Read presentation artifacts through the lifecycle-owned, bounded plugin root cache. */
export function readInstalledPluginOverview(
  manifest:
    | Pick<
        PluginManifestRecord,
        "rootDir" | "origin" | "providers" | "channels" | "contracts" | "uiCapabilities"
      >
    | undefined,
): PluginsInspectResult["overview"] {
  if (!manifest) {
    return undefined;
  }
  const read = (relativePath: string) =>
    readPluginCacheFile({
      rootDir: manifest.rootDir,
      relativePath,
      rejectHardlinks: shouldRejectHardlinkedPluginFiles(manifest),
      maxBytes: 524_288,
    });
  const readme = read("README.md");
  const packageFile = read("package.json");
  const parsed = packageFile.ok ? parsePluginCacheJson(packageFile) : undefined;
  const pkg = asRecord(parsed?.ok ? parsed.value : undefined);
  const repository =
    typeof pkg.repository === "string" ? pkg.repository : asRecord(pkg.repository).url;
  const repositoryUrl = normalizeOptionalString(repository);
  const documentationUrl = normalizeOptionalString(pkg.homepage);
  const publisherName = normalizeOptionalString(asRecord(pkg.author).name);
  return {
    capabilities: projectPluginOverviewCapabilities(
      buildPluginCapabilitySummary({ manifest, origin: manifest.origin }).declared,
      manifest.uiCapabilities,
    ),
    ...(readme.ok ? { readme: readme.contents.toString("utf8") } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(documentationUrl ? { documentationUrl } : {}),
    ...(publisherName ? { publisherName } : {}),
  };
}
