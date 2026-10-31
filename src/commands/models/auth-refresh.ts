/** Shared gateway refresh for CLI auth writes made outside the gateway process. */
import {
  callGateway,
  GatewayLocalBackendSharedAuthUnavailableError,
  isGatewayClientRequestError,
  isImplicitLocalGatewayTarget,
} from "../../gateway/call.js";
import { isGatewayTransportError } from "../../gateway/transport-error.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../../shared/provider-auth-result.js";

export type ModelAuthRefreshOutcome = "refreshed" | "gateway-rejected" | "gateway-unreachable";

export async function refreshProviderAuthAfterLogin(params: {
  agentId: string;
  refreshAfterLogin?: (agentId: string) => Promise<void>;
  runtime: RuntimeEnv;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<ModelAuthRefreshOutcome> {
  if (!params.refreshAfterLogin) {
    return refreshRunningGatewayAuthState(params.agentId, "login", params.runtime);
  }
  try {
    await params.refreshAfterLogin(params.agentId);
    return "refreshed";
  } catch {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    return "gateway-rejected";
  }
}

/** Publish committed credentials best-effort without replacing the original login failure. */
export async function throwProviderAuthLoginError(
  error: unknown,
  login: Parameters<typeof refreshProviderAuthAfterLogin>[0],
  credentialsSaved: boolean,
): Promise<never> {
  if (error instanceof ProviderAuthConfigApplyError) {
    try {
      login.signal?.throwIfAborted();
      login.assertCurrent?.();
      await refreshProviderAuthAfterLogin(login);
    } catch {
      // Ended authority publishes nothing and must not replace the settings failure.
    }
  }
  if (credentialsSaved && !(error instanceof ProviderCredentialsSavedError)) {
    throw new ProviderCredentialsSavedError(
      error instanceof Error
        ? `Provider credentials were saved, but sign-in did not finish: ${error.message}`
        : "Provider credentials were saved, but sign-in did not finish.",
      { cause: error },
    );
  }
  throw error;
}

export async function refreshRunningGatewayAuthState(
  agentId: string | undefined,
  operation: "login" | "logout" | "update",
  runtime: Pick<RuntimeEnv, "error">,
): Promise<ModelAuthRefreshOutcome> {
  let gatewayConnected = false;
  let localTarget: boolean | undefined;
  try {
    localTarget = await isImplicitLocalGatewayTarget({});
    const result = await callGateway<{ refreshed: boolean }>({
      method: "models.authRefresh",
      params: { operation, ...(agentId ? { agentId } : {}) },
      timeoutMs: 3000,
      requireLocalBackendSharedAuth: true,
      onHelloOk: () => {
        gatewayConnected = true;
      },
    });
    if (result.refreshed) {
      return "refreshed";
    }
  } catch (error) {
    if (
      isGatewayClientRequestError(error) &&
      error.gatewayCode === "INVALID_REQUEST" &&
      error.message === "unknown method: models.authRefresh"
    ) {
      // Legacy status refresh cannot acknowledge publication, so restart guidance still applies.
      await callGateway({
        method: "models.authStatus",
        params: { refresh: true, ...(agentId ? { agentId } : {}) },
        timeoutMs: 3000,
        requireLocalBackendSharedAuth: true,
      }).catch(() => undefined);
    }
    if (error instanceof GatewayLocalBackendSharedAuthUnavailableError && localTarget === false) {
      runtime.error(
        "Warning: Model auth changes were saved on this host, but the configured Gateway does not share this auth state. Run the auth command on the Gateway host (the far end of any SSH tunnel).",
      );
      return "gateway-rejected";
    }
    if (
      localTarget === true &&
      !gatewayConnected &&
      isGatewayTransportError(error) &&
      error.kind === "closed" &&
      error.code === undefined &&
      error.reason?.includes("ECONNREFUSED")
    ) {
      return "gateway-unreachable";
    }
  }
  runtime.error(
    localTarget === true
      ? `Warning: Model auth changes were saved, but the ${gatewayConnected ? "running" : "local"} Gateway could not refresh them. Run \`openclaw gateway restart\` to apply the saved changes.`
      : "Warning: Model auth changes were saved, but the configured Gateway could not be identified or refreshed. Apply the auth change on the Gateway host, or restart it there.",
  );
  return gatewayConnected ? "gateway-rejected" : "gateway-unreachable";
}
