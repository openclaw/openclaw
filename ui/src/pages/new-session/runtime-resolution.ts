import { resolveDraftAgentRuntime } from "./model-target.ts";

/** One draft-owned runtime projection, independent of text and other presentation updates. */
export function createDraftAgentRuntimeResolver() {
  let previous:
    | { inputs: readonly unknown[]; value: ReturnType<typeof resolveDraftAgentRuntime> }
    | undefined;
  return (params: Parameters<typeof resolveDraftAgentRuntime>[0]) => {
    // Owners can mutate agent/default fields in place; snapshot those scalar inputs.
    // The catalog and runtime metadata are replaced by their publishing owners.
    const inputs = [
      params.model,
      params.agentRuntime,
      params.catalog,
      params.retired,
      params.agent?.model?.primary,
      params.agent?.agentRuntime,
      params.defaults?.model,
      params.defaults?.modelProvider,
      params.defaults?.agentRuntime,
      params.modelSelectionPolicy?.restricted,
      params.modelSelectionPolicy?.defaultModel,
    ];
    if (previous?.inputs.every((value, index) => value === inputs[index])) {
      return previous.value;
    }
    const value = resolveDraftAgentRuntime(params);
    previous = { inputs, value };
    return value;
  };
}
