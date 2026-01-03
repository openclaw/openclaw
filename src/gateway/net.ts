import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

export function resolveGatewayBindHost(
  bind: import("../config/config.js").BridgeBindMode | undefined,
): string | null {
  const mode = bind ?? "loopback";
  if (mode === "loopback") return "127.0.0.1";
  if (mode === "lan") return "0.0.0.0";
  if (mode === "tailnet") return pickPrimaryTailnetIPv4() ?? null;
  if (mode === "auto") return pickPrimaryTailnetIPv4() ?? "0.0.0.0";
  return "127.0.0.1";
}

export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host);
}
