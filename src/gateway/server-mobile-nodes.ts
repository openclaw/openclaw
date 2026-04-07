import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { NodeRegistry } from "./node-registry.js";

const isMobilePlatform = (platform: unknown): boolean => {
  const p = normalizeOptionalString(platform)?.toLowerCase() ?? "";
  if (!p) {
    return false;
  }
  return p.startsWith("ios") || p.startsWith("ipados") || p.startsWith("android");
};

export function hasConnectedMobileNode(registry: NodeRegistry): boolean {
  const connected = registry.listConnected();
  return connected.some((n) => isMobilePlatform(n.platform));
}
