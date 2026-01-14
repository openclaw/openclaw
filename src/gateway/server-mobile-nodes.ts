type BridgeLike = {
  listConnected?: () => Array<{ platform?: string | null }>;
};

const isMobilePlatform = (platform: unknown): boolean => {
  const p = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (!p) return false;
  return p.startsWith("ios") || p.startsWith("ipados") || p.startsWith("android");
};

export function hasConnectedMobileNode(bridge: BridgeLike | null): boolean {
  const connected = bridge?.listConnected?.() ?? [];
  return connected.some((n) => isMobilePlatform(n.platform));
}
