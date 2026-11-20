import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { configPathAffectsConversation } from "../../../src/config/read-dependencies.js";
import type { GatewayEventFrame } from "../api/gateway.ts";

/** Config editors refresh every revision; conversations follow their readers' dependencies. */
export function isConversationConfigChange(
  event: Pick<GatewayEventFrame, "event" | "payload">,
): boolean {
  if (event.event !== "config.changed") {
    return false;
  }
  const paths = asNullableRecord(event.payload)?.changedPaths;
  return !Array.isArray(paths) || paths.some(configPathAffectsConversation);
}
