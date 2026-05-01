import type { ReplyPayload } from "../auto-reply/reply-payload.js";

const PROVIDER_INVENTORY_TOOL_NAMES = new Set(["image_generate", "video_generate"]);

function readDetailsRecord(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

export function hasProviderInventoryDetails(result: unknown): boolean {
  const details = readDetailsRecord(result);
  return Array.isArray(details?.providers);
}

export function classifyInternalToolOutputShape(params: {
  toolName?: string;
  result: unknown;
}): ReplyPayload["internalShape"] | undefined {
  if (!params.toolName || !PROVIDER_INVENTORY_TOOL_NAMES.has(params.toolName)) {
    return undefined;
  }
  return hasProviderInventoryDetails(params.result) ? "provider-inventory" : undefined;
}
