import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadModelRegistry } from "./list.registry.js";
import { modelKey } from "./shared.js";

export async function loadListModelRegistry(
  cfg: OpenClawConfig,
  opts?: { providerFilter?: string },
) {
  const loaded = await loadModelRegistry(cfg, opts);
  return {
    ...loaded,
    discoveredKeys: new Set(loaded.models.map((model) => modelKey(model.provider, model.id))),
  };
}
