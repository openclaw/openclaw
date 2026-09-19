import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../api/types.ts";
import { captureModelSetupResult, type ModelSetupTaskResult } from "./model-setup-task-result.ts";
import { MODEL_SETUP_DETECT_TIMEOUT_MS, MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";

export function detectModelSetup(
  client: GatewayBrowserClient,
  agentId?: string,
  signal?: AbortSignal,
): Promise<SystemAgentSetupDetectResult> {
  return client.request<SystemAgentSetupDetectResult>(
    "openclaw.setup.detect",
    agentId ? { agentId } : {},
    { timeoutMs: MODEL_SETUP_DETECT_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
}

function verifyModelSetup(
  client: GatewayBrowserClient,
  agentId?: string,
  signal?: AbortSignal,
  modelTarget?: "utility",
): Promise<SystemAgentSetupVerifyResult> {
  return client.request<SystemAgentSetupVerifyResult>(
    "openclaw.setup.verify",
    { ...(agentId ? { agentId } : {}), ...(modelTarget ? { modelTarget } : {}) },
    { timeoutMs: MODEL_SETUP_VERIFY_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
}

export function createModelSetupVerifyTask(host: ReactiveControllerHost) {
  return new Task<
    readonly [GatewayBrowserClient | null, string | null, "utility" | undefined],
    ModelSetupTaskResult<SystemAgentSetupVerifyResult>
  >(host, {
    autoRun: false,
    args: () => [null, null, undefined],
    task: async ([client, agentId, modelTarget], { signal }) =>
      client
        ? captureModelSetupResult(client, () =>
            verifyModelSetup(client, agentId ?? undefined, signal, modelTarget),
          )
        : initialState,
  });
}
