import {
  getRuntimeConfigAppliedHash,
  hashRuntimeConfigValue,
} from "../../config/runtime-snapshot.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import type { RuntimeEnv } from "../../runtime.js";
import type {
  ActivateSetupInferenceParams,
  ActivateSetupInferenceResult,
  VerifySetupInferenceResult,
} from "../../system-agent/setup-inference.js";
import type { GatewayRequestContext } from "./types.js";

const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const systemAgentGatewayExecutionQueue = new KeyedAsyncQueue();

export async function runSystemAgentGatewayTask<T>(task: () => Promise<T>): Promise<T> {
  // Track every accepted RPC as active, never queued: restart draining snapshots
  // active ids, so a queued OpenClaw request could otherwise outlive its socket.
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
    // Bound expensive detection, activation, and agent turns without hiding
    // accepted work from restart draining. This also makes session eviction and
    // setup writes atomic with respect to other OpenClaw gateway requests.
    systemAgentGatewayExecutionQueue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, task),
  );
}

export async function verifyGatewaySetupInference(params: {
  agentId?: string;
  modelTarget?: "utility";
  runtime: RuntimeEnv;
  context: Pick<GatewayRequestContext, "getRuntimeConfig" | "isConfigReloadSettled">;
}): Promise<VerifySetupInferenceResult> {
  const [{ readConfigFileSnapshot }, { verifySetupInference }] = await Promise.all([
    import("../../config/config.js"),
    import("../../system-agent/setup-inference.js"),
  ]);
  const runtimeConfig = params.context.getRuntimeConfig();
  const appliedHash = getRuntimeConfigAppliedHash();
  const isCurrent = () =>
    appliedHash !== null &&
    params.context.isConfigReloadSettled() &&
    params.context.getRuntimeConfig() === runtimeConfig &&
    getRuntimeConfigAppliedHash() === appliedHash;
  const isApplied = async () => {
    if (!isCurrent()) {
      return false;
    }
    const snapshot = await readConfigFileSnapshot();
    return (
      snapshot.exists &&
      snapshot.valid &&
      hashRuntimeConfigValue(snapshot.sourceConfig) === appliedHash &&
      isCurrent()
    );
  };
  const unavailable: VerifySetupInferenceResult = {
    ok: false,
    status: "unavailable",
    error:
      "Gateway settings are saved but not active yet. Wait for application or restart to finish, then retry verification.",
  };
  // The standalone verifier tests saved settings. Gateway readiness additionally
  // requires the same applied runtime before and after that asynchronous probe.
  if (!(await isApplied())) {
    return unavailable;
  }
  const verification = await verifySetupInference({
    runtime: params.runtime,
    ...(params.modelTarget ? { modelTarget: params.modelTarget } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  return (await isApplied()) ? verification : unavailable;
}

export async function activateGatewaySetupInference(
  params: Omit<ActivateSetupInferenceParams, "onActivationCompletion">,
): Promise<ActivateSetupInferenceResult> {
  let complete: (() => Promise<boolean>) | undefined;
  let restartRequired: boolean | undefined;
  let result: ActivateSetupInferenceResult;
  try {
    result = await runSystemAgentGatewayTask(async () => {
      const { activateSetupInference } = await import("../../system-agent/setup-inference.js");
      return activateSetupInference({
        ...params,
        onActivationCompletion: (completion) => {
          complete = completion;
        },
      });
    });
  } finally {
    // Reload drains setup's queue. Keep the admitted request through application and recovery.
    restartRequired = await complete?.();
  }
  return result.ok && restartRequired ? { ...result, gatewayRestartRequired: true } : result;
}
