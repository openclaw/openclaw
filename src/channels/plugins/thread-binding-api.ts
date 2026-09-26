/**
 * Bundled channel thread-binding public artifact loader.
 *
 * Reads lightweight thread placement hints without full plugin loading.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadOptionalBundledChannelPublicArtifact } from "./optional-public-artifact.js";

type ThreadBindingPlacement = "current" | "child";

type ThreadBindingApi = {
  defaultTopLevelPlacement?: unknown;
};

function loadBundledChannelThreadBindingApi(channelId: string): ThreadBindingApi | undefined {
  return loadOptionalBundledChannelPublicArtifact({
    channelId,
    artifactBasename: "thread-binding-api.js",
  });
}

function normalizeThreadBindingPlacement(value: unknown): ThreadBindingPlacement | undefined {
  const normalized = normalizeOptionalString(typeof value === "string" ? value : undefined);
  return normalized === "current" || normalized === "child" ? normalized : undefined;
}

/**
 * Resolves the default top-level thread-binding placement for a bundled channel.
 */
export function resolveBundledChannelThreadBindingDefaultPlacement(
  channelId: string,
): ThreadBindingPlacement | undefined {
  return normalizeThreadBindingPlacement(
    loadBundledChannelThreadBindingApi(channelId)?.defaultTopLevelPlacement,
  );
}
