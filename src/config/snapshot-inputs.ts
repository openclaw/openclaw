import { isDeepStrictEqual } from "node:util";
import { serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { ConfigFileSnapshot } from "./types.js";

/** Compare authored revisions and env-resolved inputs, never runtime defaults. */
export function describeConfigSnapshotInputChange(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
  options: { allowPathChange?: boolean; compareResolvedConfig?: boolean } = {},
): string | undefined {
  if (!options.allowPathChange && before.path !== after.path) {
    return "config file path changed";
  }
  if (before.exists !== after.exists) {
    return "config file was created or removed";
  }
  if ((before.hash ?? before.raw) !== (after.hash ?? after.raw)) {
    return before.raw !== after.raw
      ? "authored config file contents changed"
      : "included config contents or targets changed";
  }
  // The revision excludes env substitutions, which can change migration destinations.
  if (options.compareResolvedConfig !== false) {
    if (!isDeepStrictEqual(before.sourceConfig, after.sourceConfig)) {
      return "resolved config values changed";
    }
    // Same-text values can change from pending references to resolved literals.
    if (
      !isDeepStrictEqual(
        serializeConfigResolutionFacts(before.sourceConfig),
        serializeConfigResolutionFacts(after.sourceConfig),
      )
    ) {
      return "resolved config provenance changed";
    }
  }
  return undefined;
}
