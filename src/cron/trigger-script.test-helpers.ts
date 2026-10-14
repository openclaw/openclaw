import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import type { CronExecutionIdentityAdmission } from "./service/state.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import type { CronStoredJob } from "./types.js";

type RuntimeDeps = Parameters<typeof createCronScriptRuntime>[0];
type ScriptFixture = Omit<
  Parameters<NonNullable<RuntimeDeps["prepareRuntime"]>>[0],
  "runtimeConfig" | "signal"
> & {
  script: string;
  state: unknown;
  streamBatch?: string;
  timeoutSeconds?: number;
  toolBudget?: number;
  abortSignal?: AbortSignal;
  executionIdentity?: CronExecutionIdentityAdmission;
  deliveryAttemptFence?: CronCompletionDeliveryFence | null;
};

/** Builds scheduler-owned jobs while keeping individual runtime cases focused on their inputs. */
export function createCronScriptRuntimeFixture(deps: RuntimeDeps) {
  const runtime = createCronScriptRuntime(deps);
  const job = (params: ScriptFixture, payload: CronStoredJob["payload"]): CronStoredJob => ({
    ...makeCronJob({
      id: params.jobId,
      agentId: params.agentId,
      payload: { ...payload, toolsAllow: params.toolsAllow },
      state: { triggerState: params.state },
      ...(params.scheduledToolPolicy?.mode === "account"
        ? {
            owner: {
              agentId: params.agentId ?? "main",
              sessionKey: params.scheduledToolPolicy.ownerSessionKey,
              accountId: params.scheduledToolPolicy.ownerAccountId,
            },
          }
        : {}),
    }),
    scheduledToolPolicy: params.scheduledToolPolicy,
    toolsAllowExecTarget: params.execTarget,
  });
  return {
    evaluateTrigger: (params: ScriptFixture) =>
      runtime.evaluateTrigger({
        deliveryAttemptFence: params.deliveryAttemptFence ?? null,
        job: job(params, { kind: "agentTurn", message: "condition payload" }),
        script: params.script,
        state: params.state,
        streamBatch: params.streamBatch,
        abortSignal: params.abortSignal,
        executionIdentity: params.executionIdentity,
      }),
    executePayload: (params: ScriptFixture) =>
      runtime.executePayload({
        deliveryAttemptFence: params.deliveryAttemptFence ?? null,
        job: job(params, {
          kind: "script",
          script: params.script,
          timeoutSeconds: params.timeoutSeconds,
          toolBudget: params.toolBudget,
        }),
        streamBatch: params.streamBatch,
        abortSignal: params.abortSignal,
        executionIdentity: params.executionIdentity,
      }),
  };
}
