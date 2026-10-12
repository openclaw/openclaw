import { resolveStateDir } from "../config/state-dir.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { isGatewayExternallySupervised } from "./gateway-supervision.js";

export type DeliveryQueueStateContext = {
  stateDir: string;
  workerContext: OpenClawStateWorkerContext;
  supervisorMode?: "external";
};

export function captureDeliveryQueueStateContext(stateDir?: string): DeliveryQueueStateContext {
  const env = resolveDeliveryQueueStateEnv(stateDir);
  return {
    workerContext: captureOpenClawStateWorkerContext({ env }),
    stateDir: resolveStateDir(env),
    ...(isGatewayExternallySupervised(process.env) ? { supervisorMode: "external" as const } : {}),
  };
}

export function resolveDeliveryQueueStateEnv(
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): NodeJS.ProcessEnv {
  return context
    ? {
        ...process.env,
        OPENCLAW_STATE_DIR: context.stateDir,
        // Captured absence must not inherit a later ambient supervisor mode.
        OPENCLAW_SUPERVISOR_MODE: context.supervisorMode,
      }
    : stateDir
      ? { ...process.env, OPENCLAW_STATE_DIR: stateDir }
      : process.env;
}
