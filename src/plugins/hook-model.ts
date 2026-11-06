import { withoutIncognitoLlmContent } from "./hook-agent-observations.js";
import type {
  HookContext,
  HookEvent,
  HookResult,
  ModifyingHookPolicy,
} from "./hook-runner-types.js";

type Policy = "before_model_request";
type Observation = "model_call_started" | "model_call_ended" | "llm_input" | "llm_output";

/** Keep model policy and observation bindings together; incognito only omits observations. */
export function createModelHookBindings(
  bindPolicy: (
    name: Policy,
    policy: ModifyingHookPolicy<Policy>,
  ) => (
    event: HookEvent<Policy>,
    ctx: HookContext<Policy>,
  ) => Promise<HookResult<Policy> | undefined>,
  bindObservation: <K extends Observation>(
    name: K,
  ) => (event: HookEvent<K>, ctx: HookContext<K>) => Promise<void>,
) {
  return {
    runModelCallStarted: bindObservation("model_call_started"),
    runModelCallEnded: bindObservation("model_call_ended"),
    runBeforeModelRequest: bindPolicy("before_model_request", {
      eventForHandler: (event, result) => (result ? { ...event, payload: result.payload } : event),
      mergeResults: (_previous, next) => next,
    }),
    runLlmInput: withoutIncognitoLlmContent(bindObservation("llm_input")),
    runLlmOutput: withoutIncognitoLlmContent(bindObservation("llm_output")),
  };
}
