import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";

export type MemoryPluginStatus = {
  enabled: boolean;
  slot: string | null;
  reason?: string;
};

/** Resolves whether memory status should be shown and which slot owns it. */
export function resolveMemoryPluginStatus(cfg: OpenClawConfig): MemoryPluginStatus {
  const pluginsEnabled = cfg.plugins?.enabled !== false;
  if (!pluginsEnabled) {
    return { enabled: false, slot: null, reason: "plugins disabled" };
  }
  const raw = normalizeOptionalString(cfg.plugins?.slots?.memory) ?? "";
  if (normalizeOptionalLowercaseString(raw) === "none") {
    return { enabled: false, slot: null, reason: 'plugins.slots.memory="none"' };
  }
  return { enabled: true, slot: raw || defaultSlotIdForKey("memory") };
}
