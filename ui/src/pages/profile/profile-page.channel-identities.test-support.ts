import type { UserProfile } from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createConnectedContext, modelAccountProfile } from "./profile-page.test-support.tsx";

export const channelIdentityMethods = [
  "users.self",
  "users.listModelAccounts",
  "users.listChannelIdentities",
  "users.linkChannelIdentity",
  "users.unlinkChannelIdentity",
];

export function createChannelIdentityHarness(
  request: GatewayBrowserClient["request"],
  profile: UserProfile = modelAccountProfile,
  scopes: readonly string[] = ["operator.admin"],
) {
  const harness = createConnectedContext(request, {
    id: profile.id,
    email: profile.emails[0],
    name: profile.displayName ?? undefined,
  });
  harness.context.gateway.snapshot.hello = gatewayHelloForMethods(channelIdentityMethods, scopes);
  return harness;
}
