import type { GatewayBindMode } from "../config/types.js";
import { pickPrimaryLanIPv4, resolveGatewayBindHost } from "../gateway/net.js";
import { pickPrimaryTailnetIPv4 } from "./tailnet.js";

// Display helpers are best-effort wrappers around network discovery. Startup
// and config output should keep rendering even when interface probes fail.
function displayNetworkWarning(error: unknown, warningPrefix?: string): { warning?: string } {
  const prefix = warningPrefix?.trim();
  if (!prefix) {
    return {};
  }
  const message = error instanceof Error ? error.message.trim() : "";
  return { warning: `${prefix}: ${message || "network interface discovery failed"}.` };
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

/** Return a LAN IPv4 for display, or undefined when interface discovery fails. */
export function pickBestEffortPrimaryLanIPv4(): string | undefined {
  try {
    return pickPrimaryLanIPv4();
  } catch {
    return undefined;
  }
}

/** Return a tailnet IPv4 for display, or undefined when interface discovery fails. */
export function pickBestEffortPrimaryTailnetIPv4(): string | undefined {
  try {
    return pickPrimaryTailnetIPv4();
  } catch {
    return undefined;
  }
}

/** Resolve the gateway bind host for display, falling back to a safe placeholder. */
export async function resolveBestEffortGatewayBindHostForDisplay(params: {
  bindMode: GatewayBindMode;
  customBindHost?: string;
  warningPrefix?: string;
}): Promise<{ bindHost: string; warning?: string }> {
  try {
    return {
      bindHost: await resolveGatewayBindHost(params.bindMode, params.customBindHost),
    };
  } catch (error) {
    const warning = displayNetworkWarning(error, params.warningPrefix);
    return {
      bindHost: fallbackBindHostForDisplay(params.bindMode, params.customBindHost),
      ...warning,
    };
  }
}
