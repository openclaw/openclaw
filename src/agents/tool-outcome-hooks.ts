import type { ToolOutcomeObserver } from "./agent-tools.before-tool-call.js";
import type { SemanticNoProgressObserver } from "./semantic-no-progress.js";

type ToolOutcomeHooks = {
  onToolOutcome?: ToolOutcomeObserver;
  semanticNoProgressObserver?: SemanticNoProgressObserver;
  allocateToolOutcomeOrdinal?: () => number;
};

/** Remove the run-owned semantic observer from caller-controlled tool options. */
export function omitSemanticNoProgressObserver<T extends ToolOutcomeHooks>(
  source: T | undefined,
): Omit<T, "semanticNoProgressObserver"> | undefined {
  if (!source) {
    return source;
  }
  const { semanticNoProgressObserver: _semanticNoProgressObserver, ...safe } = source;
  return safe;
}

/** Project run-private observation callbacks into the authorized tool binding. */
export function projectToolOutcomeHooks(source?: ToolOutcomeHooks): ToolOutcomeHooks {
  return {
    ...(source?.onToolOutcome ? { onToolOutcome: source.onToolOutcome } : {}),
    ...(source?.semanticNoProgressObserver
      ? { semanticNoProgressObserver: source.semanticNoProgressObserver }
      : {}),
    ...(source?.allocateToolOutcomeOrdinal
      ? { allocateToolOutcomeOrdinal: source.allocateToolOutcomeOrdinal }
      : {}),
  };
}
