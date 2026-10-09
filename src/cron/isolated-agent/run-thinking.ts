import { resolveThinkingSelection } from "./run.runtime.js";

/** Keep candidate intent separate from the resolved model default. */
export function resolveCronCandidateThinkingSelection(
  params: Parameters<typeof resolveThinkingSelection>[0],
) {
  const { level } = resolveThinkingSelection(params);
  return { thinkLevel: level, thinkingExplicit: params.level !== undefined };
}
