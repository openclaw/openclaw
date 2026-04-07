import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
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

let bundledChannelDirNameByChannelId: Map<string, string> | null = null;

function getBundledChannelDirName(channelId: string): string | undefined {
  if (!bundledChannelDirNameByChannelId) {
    bundledChannelDirNameByChannelId = new Map(
      loadPluginManifestRegistry({})
        .plugins.filter((entry) => entry.origin === "bundled")
        .filter((entry) => typeof entry.rootDir === "string" && entry.rootDir.trim().length > 0)
        .flatMap((entry) =>
          entry.channels.map(
            (candidateChannelId) =>
              [
                candidateChannelId,
                entry.rootDir ? path.basename(entry.rootDir) : entry.id,
              ] as const,
          ),
        ),
    );
  }
  return bundledChannelDirNameByChannelId.get(channelId);
}

function loadBundledChannelPublicArtifact(
  channelId: string,
  artifactBasenames: readonly string[],
): BundledChannelContractApi | undefined {
  const dirName = getBundledChannelDirName(channelId);
  if (!dirName) {
    return undefined;
  }

  for (const artifactBasename of artifactBasenames) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<BundledChannelContractApi>({
        dirName,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
        const detail = formatErrorMessage(error);
        process.stderr.write(
          `[channel-contract-api] failed to load ${channelId} via ${dirName}/${artifactBasename}: ${detail}\n`,
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
  return loadBundledChannelPublicArtifact(channelId, ["security-contract-api.js"]);
}
