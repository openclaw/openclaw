import { normalizeToolName } from "./tool-policy.js";

export type ExplicitToolAllowlistSource = {
  label: string;
  entries: string[];
};

export function collectExplicitToolAllowlistSources(
  sources: Array<{ label: string; allow?: string[] }>,
): ExplicitToolAllowlistSource[] {
  return sources.flatMap((source) => {
    const entries = (source.allow ?? []).map((entry) => entry.trim()).filter(Boolean);
    return entries.length ? [{ label: source.label, entries }] : [];
  });
}

export function buildEmptyExplicitToolAllowlistError(params: {
  sources: ExplicitToolAllowlistSource[];
  callableToolNames: string[];
  toolsEnabled: boolean;
  disableTools?: boolean;
}): Error | null {
  const callableToolNames = params.callableToolNames.map(normalizeToolName).filter(Boolean);
  // When the caller explicitly disabled tools and no runtime toolsAllow was passed,
  // an empty tool set is intentional — not a misconfiguration.
  if (params.disableTools === true && callableToolNames.length === 0) {
    const hasRuntimeToolsAllow = params.sources.some(
      (s) => s.label === "runtime toolsAllow" && s.entries.length > 0,
    );
    if (!hasRuntimeToolsAllow) {
      return null;
    }
  }
  if (params.sources.length === 0 || callableToolNames.length > 0) {
    return null;
  }
  const requested = params.sources
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
