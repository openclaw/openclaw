import { normalizePluginId } from "../../../plugins/config-state.js";

export type StalePluginSurface =
  | "allow"
  | "deny"
  | "entries"
  | "slot"
  | "channel"
  | "heartbeat"
  | "modelByChannel";

function normalizeIds(ids: Iterable<string> | undefined): Set<string> {
  return new Set(Array.from(ids ?? [], normalizePluginId).filter(Boolean));
}

export function filterRepairableStalePluginHits<
  T extends { pluginId: string; surface: StalePluginSurface },
>(params: {
  hits: readonly T[];
  preservePluginIds?: Iterable<string>;
  surfacePreservePluginIds?: Partial<Record<StalePluginSurface, Iterable<string>>>;
}): T[] {
  const preserveIds = normalizeIds(params.preservePluginIds);
  const surfacePreserveIds = new Map(
    Object.entries(params.surfacePreservePluginIds ?? {}).map(([surface, ids]) => [
      surface,
      normalizeIds(ids),
    ]),
  );
  return params.hits.filter((hit) => {
    const id = normalizePluginId(hit.pluginId);
    return !preserveIds.has(id) && !surfacePreserveIds.get(hit.surface)?.has(id);
  });
}
