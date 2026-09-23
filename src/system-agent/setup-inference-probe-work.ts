import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SetupInferenceFailureStatus } from "./setup-inference-core.js";

export const SETUP_INFERENCE_TEST_MAX_TOKENS = 256;

export type SetupTurnFailure = {
  ok: false;
  status: SetupInferenceFailureStatus;
  error: string;
};

export type SetupTurnSuccess = {
  ok: true;
  latencyMs: number;
  text: string;
  auth: AgentExecutionAuthBinding;
};

/** Setup must release the isolated probe generation before activation can replace it. */
export async function runSetupInferenceProbeWork<TParams, TResult>(
  run: (params: TParams) => Promise<TResult>,
  params: TParams,
): Promise<TResult> {
  const failures = new Set<unknown>();
  const work = new AsyncWorkScope(failures);
  let result: TResult;
  try {
    result = await work.track(() => run(params));
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => work.drain(),
    );
  }
  if (failures.size > 0) {
    throw new AggregateError([...failures], "Inference setup probe cleanup did not finish safely.");
  }
  return result;
}
