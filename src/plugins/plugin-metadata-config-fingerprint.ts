import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

function normalizeResolvedLoadPaths(
  config: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const paths = config?.plugins?.load?.paths;
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.flatMap((entry) => {
    if (typeof entry !== "string") {
      return [];
    }
    const trimmed = entry.trim();
    return trimmed ? [resolveHomeRelativePath(trimmed, { env })] : [];
  });
}

export function resolvePluginMetadataSnapshotConfigFingerprint(
  config: OpenClawConfig | undefined,
  options: { env?: NodeJS.ProcessEnv; policyHash?: string } = {},
): string {
  const env = options.env ?? process.env;
  return JSON.stringify({
    policyHash: options.policyHash ?? resolveInstalledPluginIndexPolicyHash(config),
    pluginLoadPaths: normalizeResolvedLoadPaths(config, env),
  });
}
