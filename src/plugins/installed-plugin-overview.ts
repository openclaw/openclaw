import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginsInspectResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { shouldRejectHardlinkedPluginFiles } from "./hardlink-policy.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { readPluginCacheFile } from "./plugin-cache-files.js";

/** Read presentation artifacts through the lifecycle-owned, bounded plugin root cache. */
export function readInstalledPluginOverview(
  manifest: Pick<PluginManifestRecord, "rootDir" | "origin"> | undefined,
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
  let pkg: Record<string, unknown> = {};
  if (packageFile.ok) {
    try {
      pkg = asRecord(JSON.parse(packageFile.contents.toString("utf8")));
    } catch {
      /* Invalid optional presentation metadata does not disable plugin controls. */
    }
  }
  const repository =
    typeof pkg.repository === "string" ? pkg.repository : asRecord(pkg.repository).url;
  const repositoryUrl = normalizeOptionalString(repository);
  const documentationUrl = normalizeOptionalString(pkg.homepage);
  const publisherName = normalizeOptionalString(asRecord(pkg.author).name);
  return {
    ...(readme.ok ? { readme: readme.contents.toString("utf8") } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(documentationUrl ? { documentationUrl } : {}),
    ...(publisherName ? { publisherName } : {}),
  };
}
