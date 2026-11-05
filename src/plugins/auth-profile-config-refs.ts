import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Installed plugins can predate Doctor's rename map; these fields reference host credentials. */
export function rewritePluginAuthProfileRefs(
  config: OpenClawConfig,
  profileIdMap: ReadonlyMap<string, string>,
): boolean {
  let changed = false;
  const rewrite = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(rewrite);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (
        (key === "authProfileId" || key === "defaultAuthProfileId") &&
        typeof entry === "string"
      ) {
        const replacement = profileIdMap.get(entry.trim());
        if (replacement && replacement !== entry) {
          value[key] = replacement;
          changed = true;
        }
      } else {
        rewrite(entry);
      }
    }
  };
  for (const entry of Object.values(config.plugins?.entries ?? {})) {
    rewrite(entry.config);
  }
  for (const [channel, settings] of Object.entries(config.channels ?? {})) {
    if (!isChannelConfigMetadataKey(channel)) {
      rewrite(settings);
    }
  }
  return changed;
}
