import { resolveBundledPluginCodeIdentity } from "./bundled-plugin-code-identity.js";
import {
  getPluginInstanceIncarnation,
  getPluginInstanceSourceDigest,
} from "./plugin-instance-scope.js";
import type { PluginRecord } from "./registry-types.js";

/**
 * Code identity a restarted Gateway must match before resuming a plugin's work: the digest of a
 * live instance's captured source or, for a core-bundled plugin that loads host-owned modules,
 * its exact loaded build. Undefined when the instance is not live or has no sound identity.
 */
export function getPluginInstanceCodeIdentity(record: PluginRecord): string | undefined {
  const sourceDigest = getPluginInstanceSourceDigest(record);
  if (sourceDigest) {
    return sourceDigest;
  }
  return record.origin === "bundled" && getPluginInstanceIncarnation(record)
    ? resolveBundledPluginCodeIdentity(record)
    : undefined;
}
