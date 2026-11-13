import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { PLUGIN_NOTICE_KIND } from "./transcript-only-openclaw-assistant.js";

/**
 * Transcript-only notice a plugin posts into a session. The row's text serves every client; the
 * plugin id, notice type and JSON data let a client render a richer row for notices it knows.
 */
export type PluginNotice = {
  kind: typeof PLUGIN_NOTICE_KIND;
  pluginId: string;
  type: string;
  data: Record<string, unknown>;
};

/** Returns the notice's data when the message carries a notice of this plugin and type. */
export function readPluginNoticeData(
  message: unknown,
  pluginId: string,
  type: string,
): Record<string, unknown> | undefined {
  const marker = asOptionalRecord(asOptionalRecord(message)?.openclawDeliveryMirror);
  if (marker?.kind !== PLUGIN_NOTICE_KIND || marker.pluginId !== pluginId || marker.type !== type) {
    return undefined;
  }
  return asOptionalRecord(marker.data);
}
