import type { IncomingHttpHeaders } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeGitCoauthorIdentity,
  type GitCoauthorIdentity,
} from "../../packages/gateway-protocol/src/schema/git-coauthor-identity.js";
import { GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../state/user-preferences.js";
import type { GatewayAuthResult } from "./auth.js";

type ProxyCreditParams = {
  authConfig?: GatewayAuthConfig;
  authResult: Pick<GatewayAuthResult, "ok" | "method" | "user">;
  headers: IncomingHttpHeaders;
};

/** Undefined means this sign-in has no import owner; null clears that owner's default. */
export function resolveTrustedProxyGitCoauthor(
  params: ProxyCreditParams,
): GitCoauthorIdentity | null | undefined {
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
  return (
    normalizeGitCoauthorIdentity({
      name: header(mapping.nameHeader),
      email: header(mapping.emailHeader),
    }) ?? null
  );
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
  params.assertCurrent?.();
  if (!result?.ok) {
    throw new Error("Git co-author defaults could not be updated; reconnect to retry");
  }
}
