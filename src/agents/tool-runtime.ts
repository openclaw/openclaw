import {
  consumeTrackedToolExecutionStarted,
  peekAdjustedParamsForToolCall,
  peekTrackedToolExecutionStarted,
} from "./agent-tools.before-tool-call.state.js";
import { mergeUnresolvedMutationError, resolveSuccessfulToolMutation } from "./tool-error-state.js";
import { buildToolMutationState } from "./tool-mutation.js";

/** Process-stable tool policy passed to agent harness attempts. */
export const TOOL_EXECUTION_RUNTIME = {
  consumeStarted: consumeTrackedToolExecutionStarted,
  peekArguments: peekAdjustedParamsForToolCall,
  peekStarted: peekTrackedToolExecutionStarted,
} as const;

export const TOOL_MUTATION_RUNTIME = {
  classify: buildToolMutationState,
  mergeError: mergeUnresolvedMutationError,
  resolveSuccess: resolveSuccessfulToolMutation,
} as const;
