import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";

export type ModelSetupTaskResult<T> =
  | { client: GatewayBrowserClient; value: T }
  | { client: GatewayBrowserClient; error: unknown };

export function formatModelSetupError(error: unknown): string {
  return formatUiError(error, t("modelSetup.errors.requestFailed"));
}

export async function captureModelSetupResult<T>(
  client: GatewayBrowserClient,
  load: () => Promise<T>,
): Promise<ModelSetupTaskResult<T>> {
  try {
    return { client, value: await load() };
  } catch (error) {
    return { client, error };
  }
}

type ModelSetupDetectionResult = ModelSetupTaskResult<SystemAgentSetupDetectResult> & {
  agentId: string | null;
  hello: ApplicationGatewaySnapshot["hello"];
  token: object;
};

export function createModelSetupDetectionTask(
  host: ReactiveControllerHost,
  getHello: () => ApplicationGatewaySnapshot["hello"],
  detect: (
    client: GatewayBrowserClient,
    agentId: string | undefined,
    signal: AbortSignal,
  ) => Promise<SystemAgentSetupDetectResult>,
  onComplete: (result: ModelSetupDetectionResult) => void,
) {
  return new Task<
    readonly [GatewayBrowserClient | null, string | null, object | null],
    ModelSetupDetectionResult
  >(host, {
    autoRun: false,
    args: () => [null, null, null] as const,
    task: async ([client, agentId, token], { signal }) => {
      if (!client || !token) {
        return initialState;
      }
      const hello = getHello();
      return {
        ...(await captureModelSetupResult(client, () =>
          detect(client, agentId ?? undefined, signal),
        )),
        agentId,
        hello,
        token,
      };
    },
    onComplete,
  });
}
