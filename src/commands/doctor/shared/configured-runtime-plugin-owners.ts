import type { ConfiguredAgentHarnessRuntimeOptions } from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createInstalledPluginIndexScopeLookup } from "../../../plugins/installed-plugin-index-scope-lookup.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { collectConfiguredRuntimeIds } from "./configured-runtime-plugin-installs.js";

/** Resolve runtime selections to their manifest owners before checking plugin installation. */
export function collectConfiguredRuntimePluginIds(
  cfg: OpenClawConfig,
  options: ConfiguredAgentHarnessRuntimeOptions & { env?: NodeJS.ProcessEnv } = {},
): string[] {
  const runtimes = collectConfiguredRuntimeIds(cfg, options);
  if (runtimes.length === 0) {
    return [];
  }
  const metadata = loadManifestMetadataSnapshot({ config: cfg, env: options.env });
  const lookup = createInstalledPluginIndexScopeLookup(metadata.index);
  const ids = new Set<string>();
  for (const runtime of runtimes) {
    if (lookup.hasAgentHarnessOwners([runtime])) {
      lookup.addAgentHarnessOwners(ids, [runtime]);
    } else {
      ids.add(runtime);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
