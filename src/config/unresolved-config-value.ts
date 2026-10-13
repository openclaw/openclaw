import { formatConcreteConfigPath, type ConcreteConfigPathSegment } from "../shared/dot-path.js";
import { hasUnresolvedConfigPath } from "./resolution-facts.js";

/**
 * Reports whether config loading left a `${VAR}` reference unresolved at this value.
 * Pass the root runtime config (facts do not survive copies) and concrete path
 * segments, so peer names containing dots are quoted exactly as the loader records them.
 */
export function hasUnresolvedConfigValue(
  cfg: unknown,
  segments: readonly ConcreteConfigPathSegment[],
): boolean {
  return hasUnresolvedConfigPath(cfg, formatConcreteConfigPath(segments, cfg));
}
