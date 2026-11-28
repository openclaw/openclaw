import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import {
  GatewayOperatorAccessDeniedError,
  GatewayRequestAuthorityExpiredError,
} from "../../infra/operator-authority-error.js";
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type {
  GatewayRequestAuthorityV1,
  PluginRuntimeGatewayRequestScope,
} from "./gateway-request-scope.types.js";

type RequestGuards = {
  assertCurrent(requiredGrantPluginId?: string): void;
  revalidate?: () => Promise<void>;
};
type RequestLease = { current?: RequestGuards };

function bindGuards(lease: RequestLease) {
  const assertCurrent = (requiredGrantPluginId?: string) => {
    if (!lease.current) {
      throw new GatewayRequestAuthorityExpiredError();
    }
    lease.current.assertCurrent(requiredGrantPluginId);
  };
  return {
    assertCurrent,
    async revalidate(requiredGrantPluginId?: string) {
      assertCurrent(requiredGrantPluginId);
      if (lease.current?.revalidate) {
        await lease.current.revalidate();
        assertCurrent(requiredGrantPluginId);
      }
    },
  };
}

/** A retained projection must release its transport and original grant at handler settlement. */
export async function withPluginGatewayRequestAuthority<T>(
  scope: PluginRuntimeGatewayRequestScope,
  run: () => T,
  admission?: { personProfileId?: string; assertCurrent(): void },
): Promise<Awaited<T>> {
  const client = scope.client;
  if (!admission || !client) {
    return await withPluginRuntimeGatewayRequestScope(
      { ...scope, parentHttpRequestAuthority: undefined, readRequestAuthority: undefined },
      run,
    );
  }
  const attributionProfileId = client.authenticatedUserProfile?.profileId;
  const access = client.internal?.operatorAccessAuthority;
  const lease: RequestLease = {
    current: {
      revalidate: scope.revalidate,
      assertCurrent(requiredGrantPluginId) {
        if (
          client.invalidated ||
          client.connectionSignal?.aborted ||
          client.authenticatedUserProfile?.profileId !== attributionProfileId
        ) {
          throw new GatewayRequestAuthorityExpiredError();
        }
        admission.assertCurrent();
        if (requiredGrantPluginId !== undefined) {
          if (!access || requiredGrantPluginId !== access.requiredPolicyPlugin) {
            throw new GatewayOperatorAccessDeniedError("access-record-inactive");
          }
        }
      },
    },
  };
  const authority: GatewayRequestAuthorityV1 = Object.freeze({
    scopes: Object.freeze([...(client.connect.scopes ?? [])]),
    clientIp: client.clientIp,
    attributionProfileId,
    personProfileId:
      admission.personProfileId === attributionProfileId &&
      attributionProfileId !== GATEWAY_OWNER_PROFILE_ID
        ? admission.personProfileId
        : undefined,
    requiredGrantPluginId: access?.requiredPolicyPlugin,
    ...bindGuards(lease),
  });
  try {
    return await withPluginRuntimeGatewayRequestScope(
      {
        ...scope,
        parentHttpRequestAuthority: undefined,
        readRequestAuthority: (source) =>
          lease.current && source === client ? authority : undefined,
      },
      run,
    );
  } finally {
    lease.current = undefined;
  }
}
