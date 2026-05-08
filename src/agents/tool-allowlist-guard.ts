import { normalizeToolName } from "./tool-policy.js";

type ExplicitToolAllowlistSource = {
  label: string;
  entries: string[];
  enforceWhenToolsDisabled?: boolean;
};

export function collectExplicitToolAllowlistSources(
  sources: Array<{ label: string; allow?: string[]; enforceWhenToolsDisabled?: boolean }>,
): ExplicitToolAllowlistSource[] {
  const normalizedSources: ExplicitToolAllowlistSource[] = [];
  for (const source of sources) {
    const entries: string[] = [];
    for (const entry of source.allow ?? []) {
      const trimmed = entry.trim();
      if (trimmed) {
        entries.push(trimmed);
      }
    }
    if (entries.length === 0) {
      continue;
    }
    normalizedSources.push({
      label: source.label,
      entries,
      ...(source.enforceWhenToolsDisabled === true ? { enforceWhenToolsDisabled: true } : {}),
    });
  }
  return normalizedSources;
}

export function buildEmptyExplicitToolAllowlistError(params: {
  sources: ExplicitToolAllowlistSource[];
  callableToolNames: string[];
  toolsEnabled: boolean;
  disableTools?: boolean;
}): Error | null {
  const sources =
    params.disableTools === true
      ? params.sources.filter((source) => source.enforceWhenToolsDisabled === true)
      : params.sources;
  const callableToolNames: string[] = [];
  for (const toolName of params.callableToolNames) {
    const normalized = normalizeToolName(toolName);
    if (normalized) {
      callableToolNames.push(normalized);
    }
  }
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
