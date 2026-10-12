import { unwrapSecretSentinelsForProviderEgress } from "../agents/provider-secret-egress.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import type { ProviderPrepareRuntimeAuthContext } from "./types.js";

export async function prepareProviderRuntimeAuth(
  params: Pick<
    Parameters<typeof resolveProviderRuntimePlugin>[0],
    "provider" | "config" | "workspaceDir" | "env"
  > & {
    assertCurrent?: () => void;
    context: ProviderPrepareRuntimeAuthContext;
  },
) {
  const prepareRuntimeAuth = resolveProviderRuntimePlugin(params)?.prepareRuntimeAuth;
  if (!prepareRuntimeAuth) {
    return undefined;
  }
  // The lazy runtime import may outlive the caller's authority to exchange credentials.
  params.assertCurrent?.();
  // Secret material crosses into provider code only when that provider owns an
  // auth hook. Callers can safely pass sentinels without probing plugin state.
  const preparedInput = unwrapSecretSentinelsForProviderEgress(
    params.context.apiKey,
    "provider runtime auth exchange",
  );
  return await prepareRuntimeAuth({
    ...params.context,
    apiKey: preparedInput,
  });
}
