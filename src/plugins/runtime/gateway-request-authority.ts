import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.types.js";

/** Facts and guards from one admitted plugin handler invocation. */
export type GatewayRequestAuthorityV1 = Readonly<{
  scopes: readonly string[];
  clientIp?: string;
  /** Display attribution may identify the shared Gateway owner. */
  attributionProfileId?: string;
  /** Present only for an individually authenticated operator. */
  personProfileId?: string;
  /** Policy explicitly required by the admitted role and matched by its original grant. */
  requiredGrantPluginId?: string;
  assertCurrent(): void;
  revalidate(): Promise<void>;
}>;

type RequestGuards = { assertCurrent(): void; revalidate?: () => Promise<void> };
type RequestLease = { current?: RequestGuards };

function bindGuards(lease: RequestLease) {
  const assertCurrent = () => {
    if (!lease.current) {
      throw new Error("Gateway request authority expired");
    }
    lease.current.assertCurrent();
  };
  return {
    assertCurrent,
    async revalidate() {
      assertCurrent();
      if (lease.current?.revalidate) {
        await lease.current.revalidate();
        assertCurrent();
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
      { ...scope, readRequestAuthority: undefined },
      run,
    );
  }
  const attributionProfileId = client.authenticatedUserProfile?.profileId;
  const access = client.internal?.operatorAccessAuthority;
  const lease: RequestLease = {
    current: {
      revalidate: scope.revalidate,
      assertCurrent() {
        if (
          scope.signal?.aborted ||
          client.invalidated ||
          client.connectionSignal?.aborted ||
          client.authenticatedUserProfile?.profileId !== attributionProfileId ||
          scope.hasCurrentClientAuthority?.() === false
        ) {
          throw new Error("Gateway request authority expired");
        }
        admission.assertCurrent();
        access?.assertCurrent();
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
    // Composite live authority still includes the role-required policy when its
    // durable recovery tuple cannot represent every contributing grant.
    requiredGrantPluginId: access?.requiredPolicyPlugin,
    ...bindGuards(lease),
  });
  try {
    return await withPluginRuntimeGatewayRequestScope(
      { ...scope, readRequestAuthority: () => (lease.current ? authority : undefined) },
      run,
    );
  } finally {
    lease.current = undefined;
  }
}
