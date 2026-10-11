import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupDetectResult,
  SystemAgentSetupVerifyResult,
} from "../../api/types.ts";
import type { ControllerHost } from "../model-providers/page-controller.ts";
import type { ModelSetupConnection } from "./first-run-setup.ts";
import { captureModelSetupResult, type ModelSetupTaskResult } from "./model-setup-task-result.ts";
import { MODEL_SETUP_DETECT_TIMEOUT_MS, MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";

type ModelSetupDetectTaskResult = ModelSetupTaskResult<SystemAgentSetupDetectResult> & {
  agentId: string | null;
  hello: ModelSetupConnection["hello"];
  token: object;
};

function createSetupRequest<Args, Result>(
  host: Pick<ControllerHost, "addController">,
  request: (args: Args, signal: AbortSignal) => Promise<Result | undefined>,
  onComplete?: (result: Result) => void,
) {
  let controller: AbortController | undefined;
  host.addController({
    hostDisconnected: () => {
      const retired = controller;
      controller = undefined;
      retired?.abort();
    },
  });
  return async (args: Args): Promise<Result | undefined> => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    const result = await request(args, current.signal);
    if (controller !== current || current.signal.aborted) {
      return undefined;
    }
    if (result !== undefined) {
      onComplete?.(result);
    }
    return result;
  };
}

export function createModelSetupDetectRequest(
  host: Pick<ControllerHost, "addController">,
  options: {
    getHello: () => ModelSetupConnection["hello"];
    onComplete: (outcome: ModelSetupDetectTaskResult) => void;
  },
) {
  return createSetupRequest<
    readonly [GatewayBrowserClient | null, string | null, object | null],
    ModelSetupDetectTaskResult
  >(
    host,
    async ([client, agentId, token], signal) => {
      if (!client || !token) {
        return undefined;
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
    options.onComplete,
  );
}

export function createModelSetupVerifyRequest(host: Pick<ControllerHost, "addController">) {
  return createSetupRequest<
    readonly [GatewayBrowserClient | null, string | null, "utility" | undefined],
    ModelSetupTaskResult<SystemAgentSetupVerifyResult>
  >(host, async ([client, agentId, modelTarget], signal) =>
    client
      ? captureModelSetupResult(client, () =>
          client.request<SystemAgentSetupVerifyResult>(
            "openclaw.setup.verify",
            { ...(agentId ? { agentId } : {}), ...(modelTarget ? { modelTarget } : {}) },
            { timeoutMs: MODEL_SETUP_VERIFY_TIMEOUT_MS, signal },
          ),
        )
      : undefined,
  );
}
