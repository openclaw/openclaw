import type {
  UserProfile,
  UsersLinkChannelIdentityResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createConnectedContext, modelAccountProfile } from "./profile-page.test-support.tsx";
import { mockRpc } from "./profile-rpc.test-support.ts";

export function createChannelIdentityRequest(handlers: Parameters<typeof mockRpc>[0]) {
  return mockRpc({
    "users.self": () => ({ profile: modelAccountProfile }),
    "users.listModelAccounts": () => ({
      profileId: modelAccountProfile.id,
      accounts: [],
      links: [],
    }),
    ...handlers,
  });
}

export function fillChannelIdentityDraft(
  section: ParentNode,
  identity: UsersLinkChannelIdentityResult["identity"],
) {
  for (const [label, value] of [
    ["Channel ID", identity.channelId],
    ["Configured account ID", identity.accountId],
    ["Native sender ID", identity.senderId],
  ] as const) {
    const input = section.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

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
