import { createHash } from "node:crypto";
import type { LobsterCatalogEntry } from "../../packages/gateway-protocol/src/lobsterdex.js";
import { buildControlUiResourcePath } from "../gateway/control-ui-resource-routes.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";

const catalogByPlugin = new WeakMap<PluginManifestRecord, LobsterCatalogEntry[]>();
function currentSnapshot() {
  return getProcessGatewayPluginMetadataSnapshot() ?? getCurrentPluginMetadataSnapshot();
}
function pluginEntries(plugin: PluginManifestRecord): LobsterCatalogEntry[] {
  const cached = catalogByPlugin.get(plugin);
  if (cached) {
    return cached;
  }
  const entries = (plugin.lobsterDefinitions ?? []).flatMap((pack) =>
    pack.definition.clawmojis.map((entry): LobsterCatalogEntry => {
      const art = pack.artwork[entry.id]!;
      const hash = createHash("sha256").update(art.data, "base64").digest("hex").slice(0, 12);
      const url = `${buildControlUiResourcePath("pluginLobsterArt", "", plugin.id, [pack.id, entry.id])}?v=${hash}`;
      const { source: _source, ...appearance } = entry.appearance;
      return {
        ...entry,
        id: `${plugin.id}/${pack.id}/${entry.id}`,
        source: "plugin",
        pluginId: plugin.id,
        packId: pack.id,
        packName: pack.definition.name,
        appearance: { ...appearance, url },
      };
    }),
  );
  catalogByPlugin.set(plugin, entries);
  return entries;
}
/** Consume the current enabled metadata generation, without running plugin code. */
export function listPluginLobsters(): LobsterCatalogEntry[] {
  const snapshot = currentSnapshot();
  if (!snapshot) {
    return [];
  }
  const enabled = new Set(
    snapshot.index.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.pluginId),
  );
  return snapshot.plugins
    .flatMap((plugin) => (enabled.has(plugin.id) ? pluginEntries(plugin) : []))
    .toSorted((a, b) => a.id.localeCompare(b.id));
}
/** Serve only the captured artwork belonging to the current enabled generation. */
export function resolvePluginLobsterArtwork(pluginId: string, packId: string, characterId: string) {
  const snapshot = currentSnapshot();
  if (!snapshot?.index.plugins.some((plugin) => plugin.pluginId === pluginId && plugin.enabled)) {
    return undefined;
  }
  const pack = snapshot.plugins
    .find((plugin) => plugin.id === pluginId)
    ?.lobsterDefinitions?.find((entry) => entry.id === packId);
  return pack && Object.hasOwn(pack.artwork, characterId) ? pack.artwork[characterId] : undefined;
}
