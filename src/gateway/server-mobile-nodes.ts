import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { NodeRegistry } from "./node-registry.js";

export function hasConnectedMobileNode(registry: NodeRegistry): boolean {
  const connected = registry.listConnected();
  return connected.some((n) => {
    const platform = normalizeOptionalLowercaseString(n.platform) ?? "";
    return (
      platform.startsWith("ios") || platform.startsWith("ipados") || platform.startsWith("android")
    );
  });
}
