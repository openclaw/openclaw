import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RuntimeConfigCapability } from "./runtime-config-capability.ts";

export type ConfigMutationOwner = Pick<RuntimeConfigCapability, "runExternalMutation">;

/** Serialize config writers while preserving structured Gateway failures for their callers. */
export function createConfigMutationRunner(connectionError: string) {
  return async <T>(
    owner: ConfigMutationOwner,
    expectedClient: GatewayBrowserClient,
    task: (client: GatewayBrowserClient) => Promise<T>,
    options: { canDispatch?: () => boolean; dispatchError?: string } = {},
  ): Promise<{ value: T; refreshError: string | null }> => {
    let taskError: Error | undefined;
    const mutation = await owner.runExternalMutation(async (client) => {
      if (client !== expectedClient) {
        throw new Error(connectionError);
      }
      try {
        return await task(client);
      } catch (error) {
        taskError = error instanceof Error ? error : new Error(String(error));
        throw taskError;
      }
    }, options);
    if (!mutation.ok) {
      throw taskError ?? new Error(mutation.error);
    }
    return {
      value: mutation.value,
      refreshError: mutation.refresh.ok ? null : mutation.refresh.error,
    };
  };
}
