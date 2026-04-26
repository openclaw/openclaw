import type { GatewayBindMode } from "../config/types.js";
import { pickPrimaryLanIPv4, resolveGatewayBindHost } from "../gateway/net.js";
import { inspectNetworkInterfaces } from "./network-interfaces.js";
import { listTailnetAddressesFromSnapshot } from "./tailnet.js";

function summarizeDisplayNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return message;
    }
  }
  return "network interface discovery failed";
}

function fallbackBindHostForDisplay(bindMode: GatewayBindMode, customBindHost?: string): string {
  if (bindMode === "lan") {
    return "0.0.0.0";
  }
  if (bindMode === "custom") {
    return customBindHost?.trim() || "0.0.0.0";
  }
  return "127.0.0.1";
}

export function pickBestEffortPrimaryLanIPv4(): string | undefined {
  try {
    return pickPrimaryLanIPv4();
  } catch {
    return undefined;
  }
}

export function inspectBestEffortPrimaryTailnetIPv4(params?: { warningPrefix?: string }): {
  tailnetIPv4: string | undefined;
  warning?: string;
} {
  const { snapshot, error } = inspectNetworkInterfaces();
  const tailnetIPv4 = listTailnetAddressesFromSnapshot(snapshot).ipv4[0];
  if (error) {
    const prefix = params?.warningPrefix?.trim();
    const warning = prefix ? `${prefix}: ${summarizeDisplayNetworkError(error)}.` : undefined;
    return { tailnetIPv4, ...(warning ? { warning } : {}) };
  }
  return { tailnetIPv4 };
}

export async function resolveBestEffortGatewayBindHostForDisplay(params: {
  bindMode: GatewayBindMode;
  customBindHost?: string;
  warningPrefix?: string;
}): Promise<{ bindHost: string; warning?: string }> {
  const interfaceDiscoveryError =
    params.bindMode === "tailnet" ? inspectNetworkInterfaces().error : undefined;
  try {
    const prefix = params.warningPrefix?.trim();
    const warning =
      interfaceDiscoveryError && prefix
        ? `${prefix}: ${summarizeDisplayNetworkError(interfaceDiscoveryError)}.`
        : undefined;
    return {
      bindHost: await resolveGatewayBindHost(params.bindMode, params.customBindHost),
      ...(warning ? { warning } : {}),
    };
  } catch (error) {
    const prefix = params.warningPrefix?.trim();
    const warning = prefix ? `${prefix}: ${summarizeDisplayNetworkError(error)}.` : undefined;
    return {
      bindHost: fallbackBindHostForDisplay(params.bindMode, params.customBindHost),
      ...(warning ? { warning } : {}),
    };
  }
}
