import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readTrimmedStringAlias } from "../../utils/string-readers.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";
import type { RunMessageActionParams } from "./message-action-runner.js";

function hasExplicitSingularTargetParam(params: Record<string, unknown>): boolean {
  return readTrimmedStringAlias(params, ["target", "to", "channelId"]) !== undefined;
}

/** Return whether message-action params explicitly include one or more targets. */
export function hasExplicitTargetParam(params: Record<string, unknown>): boolean {
  return (
    hasExplicitSingularTargetParam(params) ||
    (Array.isArray(params.targets) &&
      params.targets.some((value) => normalizeOptionalString(value)))
  );
}

/** Return whether core or plugin action context can supply a target. */
export function hasPotentialActionTargetInput(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): boolean {
  return Boolean(
    hasExplicitSingularTargetParam(params) ||
    normalizeOptionalString(input.toolContext?.currentChannelId) ||
    normalizeOptionalString(input.toolContext?.currentMessagingTarget) ||
    hasPotentialPluginActionParam(params),
  );
}
