// The profile-link rule for a device sign-in on a personal connection (openclawId.account
// device_poll and link_held, and the remote access commit in openclaw-id.ts).
import { normalizeProfileEmail } from "../../state/user-profile-email.kernel.js";
import { classifyTailscaleLogin } from "../../state/user-profiles-tailscale-login.js";
import type { OpenClawIdAccount } from "../openclaw-id/claw-store.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// The email this connection's own sign-in verified: a Tailscale login or trusted-proxy user
// that is an email address. Provider logins (`user@github`) and other user names have none.
function connectionVerifiedEmail(client: GatewayRequestHandlerOptions["client"]) {
  const login = client?.authenticatedUserId;
  if (!login || client.authenticatedUserIsTailscaleProvider) {
    return undefined;
  }
  const classified = classifyTailscaleLogin(login);
  return classified.kind === "email" ? normalizeProfileEmail(classified.email) : undefined;
}

// Whether the issuer verified the account's email and it is this connection's own email.
function matchesConnectionEmail(
  client: GatewayRequestHandlerOptions["client"],
  account: OpenClawIdAccount,
) {
  const own = connectionVerifiedEmail(client);
  return Boolean(
    own &&
    account.emailVerified === true &&
    account.email?.trim() &&
    normalizeProfileEmail(account.email) === own,
  );
}

// A device-code approval (RFC 8628) does not show who approved it. A device sign-in reports an
// existing link, and creates a profile's first link only when the issuer verified the account's
// email and it equals this connection's own verified email. Otherwise an owner-approved
// invitation makes the first link. Stored email aliases never count.
export async function resolveVerifiedProfileLink(
  opts: GatewayRequestHandlerOptions,
  profileId: string,
  account: OpenClawIdAccount,
  assertCurrent: () => void,
) {
  const { readOpenClawIdLinkedProfile, readOpenClawIdLinksOfProfile } =
    await import("../../state/user-profile-openclaw-id.js");
  const binding = await readOpenClawIdLinkedProfile(account.sub);
  if (binding) {
    return binding.profileId === profileId ? "linked" : "linked_elsewhere";
  }
  // A profile that already holds another account needs an unlink, not an invitation.
  if ((await readOpenClawIdLinksOfProfile(profileId)).length > 0) {
    return "profile_linked";
  }
  if (!matchesConnectionEmail(opts.client, account)) {
    return "link_approval_required";
  }
  const { linkCanonicalOpenClawIdUserProfile } =
    await import("../../state/user-profile-openclaw-id.js");
  const linked = await linkCanonicalOpenClawIdUserProfile(
    { profileId, accountId: account.sub, email: account.email },
    { assertCurrent },
  );
  return linked.ok ? "linked" : linked.code;
}
