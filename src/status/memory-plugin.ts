import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfigWithResolverCore } from "../plugins/config-normalization-core.js";

export type MemoryPluginStatus = {
  enabled: boolean;
  slot: string | null;
  reason?: string;
};

/** Resolves whether memory status should be shown and which slot owns it. */
export function resolveMemoryPluginStatus(cfg: OpenClawConfig): MemoryPluginStatus {
  const plugins = normalizePluginsConfigWithResolverCore(cfg.plugins);
  if (!plugins.enabled) {
    return { enabled: false, slot: null, reason: "plugins disabled" };
  }
  const slot = plugins.slots.memory;
  if (!slot) {
    return { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' };
  }
  if (plugins.entries[slot]?.enabled === false) {
    return { enabled: false, slot, reason: `plugins.entries.${slot}.enabled=false` };
  }
  return { enabled: true, slot };
}
