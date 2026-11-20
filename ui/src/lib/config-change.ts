import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayEventFrame } from "../api/gateway.ts";

/** Browser profile lifecycle does not change conversation, identity or model facts. */
export function isConversationConfigChange(
  event: Pick<GatewayEventFrame, "event" | "payload">,
): boolean {
  if (event.event !== "config.changed") {
    return false;
  }
  const paths = asNullableRecord(event.payload)?.changedPaths;
  return (
    !Array.isArray(paths) ||
    paths.some(
      (path: unknown) =>
        typeof path !== "string" ||
        (path !== "browser.profiles" &&
          !path.startsWith("browser.profiles.") &&
          path !== "meta.lastTouchedVersion"),
    )
  );
}
