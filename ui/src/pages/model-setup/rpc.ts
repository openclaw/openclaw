import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../api/types.ts";
import type { ModelSetupConnection } from "./first-run-setup.ts";
import { captureModelSetupResult, type ModelSetupTaskResult } from "./model-setup-task-result.ts";
import { MODEL_SETUP_DETECT_TIMEOUT_MS, MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";

type ModelSetupDetectTaskResult = ModelSetupTaskResult<SystemAgentSetupDetectResult> & {
  agentId: string | null;
  hello: ModelSetupConnection["hello"];
  token: object;
};

export function createModelSetupDetectTask(
  host: ReactiveControllerHost,
  options: {
    getHello: () => ModelSetupConnection["hello"];
    onComplete: (outcome: ModelSetupDetectTaskResult) => void;
  },
) {
  return new Task<
    readonly [GatewayBrowserClient | null, string | null, object | null],
    ModelSetupDetectTaskResult
  >(host, {
    autoRun: false,
    args: () => [null, null, null],
    task: async ([client, agentId, token], { signal }) => {
      if (!client || !token) {
        return initialState;
      }
      const hello = options.getHello();
      return {
        ...(await captureModelSetupResult(client, () =>
          client.request<SystemAgentSetupDetectResult>(
            "openclaw.setup.detect",
            agentId ? { agentId } : {},
            { timeoutMs: MODEL_SETUP_DETECT_TIMEOUT_MS, signal },
          ),
        )),
        agentId,
        hello,
        token,
      };
    },
    onComplete: options.onComplete,
  });
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
            client.request<SystemAgentSetupVerifyResult>(
              "openclaw.setup.verify",
              { ...(agentId ? { agentId } : {}), ...(modelTarget ? { modelTarget } : {}) },
              { timeoutMs: MODEL_SETUP_VERIFY_TIMEOUT_MS, signal },
            ),
          )
        : initialState,
  });
}
