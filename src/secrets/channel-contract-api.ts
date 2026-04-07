import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { listBundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

type BundledChannelContractApi = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
  unsupportedSecretRefSurfacePatterns?: readonly string[];
  collectUnsupportedSecretRefConfigCandidates?: (
    raw: Record<string, unknown>,
  ) => UnsupportedSecretRefConfigCandidate[];
};

function loadBundledChannelPublicArtifact(
  channelId: string,
  artifactBasenames: readonly string[],
): BundledChannelContractApi | undefined {
  const metadata = listBundledPluginMetadata({
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).find((entry) => entry.manifest.channels?.includes(channelId));
  if (!metadata) {
    return undefined;
  }

  for (const artifactBasename of artifactBasenames) {
    if (!metadata.publicSurfaceArtifacts?.includes(artifactBasename)) {
      continue;
    }
    try {
      return loadBundledPluginPublicArtifactModuleSync<BundledChannelContractApi>({
        dirName: metadata.dirName,
        artifactBasename,
      });
    } catch (error) {
      if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
        const detail = formatErrorMessage(error);
        process.stderr.write(
          `[channel-contract-api] failed to load ${channelId} via ${metadata.dirName}/${artifactBasename}: ${detail}\n`,
        );
      }
    }
  }

  return undefined;
}

export type BundledChannelSecretContractApi = Pick<
  BundledChannelContractApi,
  "collectRuntimeConfigAssignments" | "secretTargetRegistryEntries"
>;

export function loadBundledChannelSecretContractApi(
  channelId: string,
): BundledChannelSecretContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["secret-contract-api.js", "contract-api.js"]);
}

export type BundledChannelSecurityContractApi = Pick<
  BundledChannelContractApi,
  "unsupportedSecretRefSurfacePatterns" | "collectUnsupportedSecretRefConfigCandidates"
>;

export function loadBundledChannelSecurityContractApi(
  channelId: string,
): BundledChannelSecurityContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, [
    "security-contract-api.js",
    "contract-api.js",
  ]);
}
