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
  host: ControllerHost,
  request: (args: Args, signal: AbortSignal) => Promise<Result | undefined>,
  onComplete?: (result: Result) => void,
) {
  let controller: AbortController | undefined;
  let value: Result | undefined;
  let completion: Promise<Result | undefined> = Promise.resolve(undefined);
  const retire = () => {
    const retired = controller;
    controller = undefined;
    retired?.abort();
  };
  host.addController({ hostDisconnected: retire });
  return {
    get value() {
      return value;
    },
    get taskComplete() {
      return completion;
    },
    abort: retire,
    run(args: Args): Promise<void> {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      completion = request(args, current.signal).then((result) => {
        if (controller === current && !current.signal.aborted) {
          value = result;
          if (result !== undefined) {
            onComplete?.(result);
          }
          host.requestUpdate();
        }
        return result;
      });
      return completion.then(() => undefined);
    },
  };
}

export function createModelSetupDetectTask(
  host: ControllerHost,
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

export function createModelSetupVerifyTask(host: ControllerHost) {
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
