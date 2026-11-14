import type { IncomingHttpHeaders } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY,
  normalizeGitCoauthorIdentity,
  gitCoauthorOrganizationPolicy,
  type GitCoauthorOrganizationIdentity,
} from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../state/user-preferences.js";
import { emitUserProfilesChanged } from "../state/user-profile-events.js";
import type { GatewayAuthResult } from "./auth.js";

type ProxyCreditParams = {
  authConfig?: GatewayAuthConfig;
  authResult: Pick<GatewayAuthResult, "ok" | "method" | "user">;
  headers: IncomingHttpHeaders;
};

/** Undefined means this sign-in has no import owner; null clears that owner's default. */
function resolveTrustedProxyGitCoauthor(
  params: ProxyCreditParams,
): GitCoauthorOrganizationIdentity | null | undefined {
  const mapping = params.authConfig?.trustedProxy?.gitCoauthor;
  if (
    !mapping ||
    params.authConfig?.mode !== "trusted-proxy" ||
    !params.authResult.ok ||
    params.authResult.method !== "trusted-proxy" ||
    !params.authResult.user
  ) {
    return undefined;
  }
  const header = (name: string) => params.headers[name.toLowerCase()];
  if (mapping.emailVerifiedHeader && header(mapping.emailVerifiedHeader) !== "true") {
    return null;
  }
  const identity = normalizeGitCoauthorIdentity({
    name: header(mapping.nameHeader),
    email: header(mapping.emailHeader),
  });
  return identity
    ? {
        ...identity,
        policy: gitCoauthorOrganizationPolicy(params.authConfig.trustedProxy?.userHeader, mapping),
      }
    : null;
}

/** Import only after the caller has resolved this admitted principal's canonical profile. */
export async function syncTrustedProxyGitCoauthor(
  params: ProxyCreditParams & { profileId: string; assertCurrent?: () => void },
): Promise<void> {
  const identity = resolveTrustedProxyGitCoauthor(params);
  if (identity === undefined) {
    return;
  }
  params.assertCurrent?.();
  const current = await getCanonicalUserPreferences(params.profileId, [
    GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY,
  ]);
  params.assertCurrent?.();
  if (!current) {
    throw new Error("Git co-author defaults require an authenticated profile");
  }
  const previous = current.entries[GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY] ?? null;
  if (isDeepStrictEqual(previous, identity)) {
    return;
  }
  const result = await setCanonicalUserPreferences(
    params.profileId,
    { [GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY]: identity },
    { assertCurrent: params.assertCurrent, trustedProxyGitCoauthor: true },
  );
  if (!result?.ok) {
    throw new Error("Git co-author defaults could not be updated; reconnect to retry");
  }
  // A committed import must invalidate views even if this caller was revoked after its write.
  emitUserProfilesChanged();
  params.assertCurrent?.();
}
