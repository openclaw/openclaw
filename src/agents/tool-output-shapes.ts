/**
 * Shape detectors for tool-result payloads whose visibility on shared chat
 * surfaces (Discord guild channels, group rooms) needs stricter handling than
 * arbitrary tool output. Kept as a tiny pure module so both the agent
 * emission path and the reply dispatcher can reach the same detection without
 * duplicating logic. Refs #75166.
 */

export type InternalToolOutputShape = "provider-inventory";

function readDetailsRecord(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined;
}

/**
 * Returns true when a tool result carries the canonical
 * `details.providers: [...]` shape used by `image_generate` /
 * `video_generate` `action=list` and the shared media-generate list helper.
 * This shape contains operator environment data (provider ids, models,
 * configured state, auth env-var hints) that must not leak to non-direct
 * chat surfaces by default.
 */
export function hasProviderInventoryDetails(result: unknown): boolean {
  const details = readDetailsRecord(result);
  return Array.isArray(details?.providers);
}

/**
 * Maps a tool result to an internal shape tag that downstream delivery code
 * uses to gate visibility. Returns undefined when no internal shape applies
 * and the payload should follow normal tool-output routing.
 */
export function classifyInternalToolOutputShape(
  result: unknown,
): InternalToolOutputShape | undefined {
  if (hasProviderInventoryDetails(result)) {
    return "provider-inventory";
  }
  return undefined;
}
