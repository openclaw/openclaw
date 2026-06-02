import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeToolList, normalizeToolName } from "./tool-policy.js";

type ExplicitToolAllowlistSource = {
  /** User-facing config/runtime source shown in fail-closed diagnostics. */
  label: string;
  /** Normalized requested tool names from this source. */
  entries: string[];
  /** Runtime allowlists still fail closed when the run explicitly disables tools. */
  enforceWhenToolsDisabled?: boolean;
};

/** Collect non-empty explicit allowlists while preserving their diagnostic source labels. */
export function collectExplicitToolAllowlistSources(
  sources: Array<{ label: string; allow?: string[]; enforceWhenToolsDisabled?: boolean }>,
): ExplicitToolAllowlistSource[] {
  return sources.flatMap((source) => {
    const entries = normalizeStringEntries(source.allow);
    if (entries.length === 0) {
      return [];
    }
    return [
      {
        label: source.label,
        entries,
        ...(source.enforceWhenToolsDisabled === true ? { enforceWhenToolsDisabled: true } : {}),
      },
    ];
  });
}

/** Build a fail-closed error when explicit allowlists leave no callable tool. */
export function buildEmptyExplicitToolAllowlistError(params: {
  sources: ExplicitToolAllowlistSource[];
  callableToolNames: string[];
  toolsEnabled: boolean;
  disableTools?: boolean;
}): Error | null {
  const sources =
    params.disableTools === true
      ? // Inherited config allowlists should not block intentional text-only runs; runtime allowlists should.
        params.sources.filter((source) => source.enforceWhenToolsDisabled === true)
      : params.sources;
  const callableToolNames = normalizeToolList(params.callableToolNames);
  if (sources.length === 0 || callableToolNames.length > 0) {
    return null;
  }
  const requested = sources
    .map((source) => `${source.label}: ${source.entries.map(normalizeToolName).join(", ")}`)
    .join("; ");
  const reason =
    params.disableTools === true
      ? "tools are disabled for this run"
      : params.toolsEnabled
        ? "no registered tools matched"
        : "the selected model does not support tools";
  return new Error(
    `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
  );
}
