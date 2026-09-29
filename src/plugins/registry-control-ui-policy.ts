import { classifyGatewayProbePath } from "../gateway/gateway-http-route-contracts.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";

const reservedTabSlugs = new Set([
  "api",
  "plugins",
  "plugin",
  "focus",
  "approve",
  "ask",
  "share",
  "j",
  "v1",
  "ui",
  "mcp-app-sandbox",
  "__openclaw__",
  "__openclaw",
  "sessions",
  "agent",
  "agents",
]);

export function isReservedControlUiTabSlug(slug: string): boolean {
  return reservedTabSlugs.has(slug) || classifyGatewayProbePath(`/${slug}`) !== "outside";
}

export function validateControlUiNativeRoutePlacement(params: {
  record: PluginRecord;
  placement: string | undefined;
  pushDiagnostic: PluginRegistryState["pushDiagnostic"];
}): boolean {
  if (!params.placement?.startsWith("route:")) {
    return true;
  }
  if (params.record.origin === "bundled" && params.placement === `route:${params.record.id}`) {
    return true;
  }
  params.pushDiagnostic({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `native Control UI route placement must be owned by its bundled plugin: ${params.placement}`,
  });
  return false;
}
