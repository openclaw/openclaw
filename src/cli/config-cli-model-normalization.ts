import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeSubmittedConfigModelRefs } from "../config/model-input-normalization.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasInstalledPluginIndexWorkspaceScopeMismatch } from "../plugins/installed-plugin-index.js";
import { resolvePluginControlPlaneFingerprint } from "../plugins/plugin-control-plane-context.js";
import {
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { PathSegment } from "./config-cli-path.js";

export function shouldNormalizeConfigMutationProviderCatalogs(params: {
  before: OpenClawConfig;
  after: OpenClawConfig;
  touchedPaths: readonly (readonly PathSegment[])[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  const catalogPath = ["models", "providers"];
  if (
    params.touchedPaths.some((path) =>
      catalogPath
        .slice(0, Math.min(path.length, catalogPath.length))
        .every((part, index) => path[index] === part),
    ) ||
    !isDeepStrictEqual(params.before.models?.providers, params.after.models?.providers)
  ) {
    return true;
  }
  if (!params.before.models?.providers && !params.after.models?.providers) {
    return false;
  }
  // Plugin roots and activation can change catalog policies without changing IDs.
  return (
    resolvePluginControlPlaneFingerprint({ config: params.before, env: params.env }) !==
    resolvePluginControlPlaneFingerprint({ config: params.after, env: params.env })
  );
}

export function normalizeConfigMutationModelRefs(
  cfg: OpenClawConfig,
  options: {
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    env?: NodeJS.ProcessEnv;
    normalizeProviderCatalogs?: boolean;
  } = {},
): OpenClawConfig {
  return normalizeSubmittedConfigModelRefs(
    cfg,
    () => {
      const env = options.env ?? process.env;
      const prepared = options.pluginMetadataSnapshot;
      const pluginMetadata =
        prepared &&
        // Preserve global normalization policies; config reads can include workspace plugins.
        !hasInstalledPluginIndexWorkspaceScopeMismatch(prepared.index, undefined) &&
        isPluginMetadataSnapshotCompatible({
          snapshot: prepared,
          config: cfg,
          env,
        })
          ? prepared
          : loadPluginMetadataSnapshot({ config: cfg, env });
      return pluginMetadata.owners.modelIdNormalizationPolicies;
    },
    options,
  );
}

export function normalizeConfigMutationExplicitSetPath(path: PathSegment[]): PathSegment[] {
  const modelKeyIndex =
    path[0] === "agents" && path[1] === "defaults" && path[2] === "models"
      ? 3
      : path[0] === "agents" &&
          (path[1] === "entries" || path[1] === "list") &&
          path[3] === "models"
        ? 4
        : undefined;
  if (modelKeyIndex !== undefined && path.length > modelKeyIndex) {
    const modelId = expectDefined(path[modelKeyIndex], `path entry at ${modelKeyIndex}`);
    const normalizedModelId = normalizeAgentModelRefForConfig(modelId);
    return normalizedModelId === modelId
      ? path
      : [...path.slice(0, modelKeyIndex), normalizedModelId, ...path.slice(modelKeyIndex + 1)];
  }
  return path;
}
