import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMemorySidecarEnabled } from "./config-normalization-shared.js";
import {
  normalizePluginsConfig,
  resolveSelectedContextEnginePluginId,
  type ContextEngineOwnerMetadata,
} from "./config-state.js";
import { isBundledManifestOwner } from "./manifest-owner-policy.js";
import type { PluginKind } from "./plugin-kind.types.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { applyExclusiveSlotSelection } from "./slots.js";

function withoutMemoryKind(kind: PluginKind | PluginKind[] | undefined) {
  if (kind === "memory") {
    return undefined;
  }
  if (Array.isArray(kind)) {
    const rest = kind.filter((entry) => entry !== "memory");
    return rest.length === 0 ? undefined : rest.length === 1 ? rest[0] : rest;
  }
  return kind;
}

export async function applySlotSelectionForPlugin(
  config: OpenClawConfig,
  pluginId: string,
  preparedMetadata?: PluginMetadataSnapshot,
  beforeRuntimeInspection?: () => void,
  warn?: (message: string) => void,
  ownershipRecords?: readonly ContextEngineOwnerMetadata[],
): Promise<OpenClawConfig> {
  // Selection inspects the install candidate, never the running Gateway's inventory.
  const metadataSnapshot =
    preparedMetadata ??
    loadPluginMetadataSnapshot({
      allowCurrent: false,
      config,
      env: process.env,
    });
  const plugin = metadataSnapshot.plugins.find((entry) => entry.id === pluginId);
  if (!plugin) {
    return config;
  }
  // Reconstruct legacy ownership without letting a plugin-ID match displace a declared owner.
  const legacyContextEngineOwnerId = resolveSelectedContextEnginePluginId(
    config,
    (ownershipRecords ?? metadataSnapshot.plugins).map((entry) =>
      entry.id === plugin.id ? { id: entry.id } : entry,
    ),
  );
  let selectedKind = plugin.kind;
  if (!selectedKind && !isBundledManifestOwner(plugin)) {
    // Bundled manifests own slot declarations. Only legacy external plugins need
    // runtime kind inspection; enabling a bundled non-slot plugin must not execute its module.
    const { withPluginDiagnosticsReport } = await import("./status.js");
    // Importing diagnostics yields; recheck the install owner before plugin code executes.
    beforeRuntimeInspection?.();
    selectedKind = await withPluginDiagnosticsReport(
      {
        config,
        onlyPluginIds: [plugin.id],
        metadataSnapshot,
        loadMode: "validate",
      },
      (runtimeReport) => {
        const runtimePlugin = runtimeReport.plugins.find((entry) => entry.id === plugin.id);
        return runtimePlugin?.kind ?? plugin.kind;
      },
    );
  }

  // An operator-approved memory sidecar is enabled beside the slot owner; it never takes the slot.
  if (isMemorySidecarEnabled(normalizePluginsConfig(config.plugins), plugin.id)) {
    selectedKind = withoutMemoryKind(selectedKind);
  }
  return applyExclusiveSlotSelection({
    config,
    selectedId: plugin.id,
    selectedKind,
    contextEngineIds: plugin.contextEngineIds,
    legacyContextEngineOwnerId,
    warn,
  });
}
