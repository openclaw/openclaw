import { extractApplyPatchTargetPaths } from "../agents/apply-patch-paths.js";

/**
 * Derived metadata stamped on `before_tool_call` events for plugin handlers.
 *
 * The host owns parsing of well-known tool param shapes (e.g. apply_patch)
 * once per call so plugins do not need to re-parse and re-validate the same
 * envelopes. Fields are optional and additive: a missing field means the
 * derivation produced nothing usable, never that it failed loudly.
 */
export type HostToolDerivedParams = {
  /** Destination paths the tool intends to read or write, when discoverable. */
  derivedPaths?: string[];
};

type HostToolParamParser = (params: unknown) => HostToolDerivedParams;

/**
 * Per-tool host-owned param derivers. Keep this map small and focused — every
 * entry runs synchronously inside the before_tool_call hot path.
 */
const HOST_TOOL_PARAM_PARSERS: Record<string, HostToolParamParser> = {
  apply_patch: (params) => {
    const paths = extractApplyPatchTargetPaths(params);
    return paths.length > 0 ? { derivedPaths: paths } : {};
  },
};

/**
 * Derive host-owned metadata for a tool call. Returns an empty object when no
 * parser is registered for the tool, which lets callers spread the result
 * unconditionally without a nullability check.
 */
export function deriveToolParams(toolName: string, params: unknown): HostToolDerivedParams {
  const parser = HOST_TOOL_PARAM_PARSERS[toolName];
  return parser ? parser(params) : {};
}
