import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { isRedactedSecretValue } from "../config/redact-sentinel.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHostAccountName } from "../infra/host-account-name.js";
import {
  GatewayControlUiIngressError,
  type GatewayIngressPrincipal,
} from "../plugins/gateway-ingress.types.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
} from "../state/user-profile-list.js";
import { ensureCanonicalGatewayOwnerProfile } from "../state/user-profile-writes.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";
import type { RemoteIngressPrincipalSnapshot } from "./server/client-identity-types.js";

function remoteControlUiGatewayAuthError(
  auth: ResolvedGatewayAuth,
  cfg: OpenClawConfig,
  principal: GatewayIngressPrincipal,
): string | undefined {
  if (principal.kind === "person") {
    const proxy = auth.trustedProxy;
    if (
      auth.mode !== "trusted-proxy" ||
      !cfg.gateway?.roles ||
      proxy?.userHeader.trim().toLowerCase() !== "cf-access-authenticated-user-email" ||
      !proxy.requiredHeaders?.some(
        (header) => header.trim().toLowerCase() === "cf-access-jwt-assertion",
      )
    ) {
      return "Person ingress requires trusted-proxy authentication with verified Cloudflare Access profiles and gateway.roles. Approve the grant from the person's authenticated Gateway Control UI.";
    }
    return undefined;
  }
  if (cfg.gateway?.roles) {
    return "Owner ingress does not support gateway.roles. Use a person-bound grant approved in the Gateway Control UI.";
  }
  if (auth.mode !== "token" && auth.mode !== "password") {
    return "Owner ingress requires gateway.auth.mode token or password without gateway.roles. Trusted-proxy Gateways require a person-bound grant.";
  }
  if (isRedactedSecretValue(auth[auth.mode])) {
    return "Remote Control UI ingress cannot use a redacted Gateway credential. Replace the configured token or password with its real value locally before opening ingress.";
  }
  return undefined;
}

/** One grant resolves its person once, then reads the existing profile owner's live facts. */
export async function prepareRemoteIngressPrincipal(params: {
  principal: GatewayIngressPrincipal;
  operatorScopeCeiling: readonly string[];
  getRuntimeConfig(): OpenClawConfig;
  getResolvedAuth(): ResolvedGatewayAuth;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<{
  resolve(): RemoteIngressPrincipalSnapshot;
  assertCurrent(this: void): void;
  readonly signal: AbortSignal;
  close(): void;
}> {
  const invalidated = new AbortController();
  const bindingId = randomUUID();
  const principal = params.principal;
  const ceiling = [...params.operatorScopeCeiling];
  const assertGrant = () => {
    invalidated.signal.throwIfAborted();
    params.signal.throwIfAborted();
    params.assertCurrent();
    const error = remoteControlUiGatewayAuthError(
      params.getResolvedAuth(),
      params.getRuntimeConfig(),
      principal,
    );
    if (error) {
      throw new GatewayControlUiIngressError("unsupported-auth", error);
    }
  };
  assertGrant();
  if (principal.kind === "person" && principal.profileId === GATEWAY_OWNER_PROFILE_ID) {
    throw new GatewayControlUiIngressError(
      "forbidden",
      "Person ingress requires an existing non-owner verified profile.",
    );
  }
  const profileId = principal.kind === "person" ? principal.profileId : GATEWAY_OWNER_PROFILE_ID;
  if (principal.kind === "owner") {
    const displayName = await resolveHostAccountName();
    assertGrant();
    await ensureCanonicalGatewayOwnerProfile(displayName, { assertCurrent: assertGrant });
  }
  const prepared = await prepareUserProfileIdentity(profileId).catch(() => {
    throw new GatewayControlUiIngressError(
      "forbidden",
      "Remote ingress requires an available existing verified profile.",
    );
  });
  const invalidate = (error: unknown): never => {
    const denial =
      error instanceof GatewayControlUiIngressError
        ? error
        : new GatewayControlUiIngressError(
            "forbidden",
            "Remote ingress principal authority changed; reopen the binding under current authority.",
          );
    invalidated.abort(denial);
    prepared.release();
    throw denial;
  };
  try {
    assertGrant();
    const resident = captureResidentUserProfileAccess(profileId);
    const initialIdentity = prepared.readCurrentFacts();
    const initial = initialIdentity.profile;
    const emailBindingIds = prepared.emailBindingIds;
    const readRole = (current: typeof initial) =>
      resolveOperatorRolePolicyForAssignment(
        profileId,
        current.assignedRole,
        params.getRuntimeConfig(),
        current.githubLogin ?? null,
      );
    const role = principal.kind === "person" ? structuredClone(readRole(initial)) : undefined;
    const access =
      principal.kind === "person"
        ? resolveGatewayOperatorAccessAuthority(profileId, params.getRuntimeConfig(), {
            requireLivePolicySet: true,
          })
        : undefined;
    const signal = AbortSignal.any([
      params.signal,
      invalidated.signal,
      ...(access ? [access.signal] : []),
    ]);
    const assertCurrent = () => {
      try {
        assertGrant();
        const currentIdentity = prepared.readCurrentFacts(emailBindingIds);
        const current = currentIdentity.profile;
        const row = resident.assertCurrent();
        const allowedUsers = params.getResolvedAuth().trustedProxy?.allowUsers;
        if (
          !isDeepStrictEqual(currentIdentity.aliases, initialIdentity.aliases) ||
          initial.emails.some((email) => !current.emails.includes(email)) ||
          initial.githubAccountIds?.some((id) => !current.githubAccountIds?.includes(id)) ||
          (principal.kind === "person" &&
            allowedUsers?.length &&
            !current.emails.some((email) => allowedUsers.includes(email))) ||
          !isDeepStrictEqual(role, principal.kind === "person" ? readRole(current) : undefined)
        ) {
          throw new Error("Principal identity or role changed");
        }
        access?.assertCurrent();
        return { ...currentIdentity, row };
      } catch (error) {
        return invalidate(error);
      }
    };
    signal.addEventListener("abort", prepared.release, { once: true });
    assertCurrent();
    return {
      signal,
      assertCurrent,
      resolve() {
        const { profile, aliases, row } = assertCurrent();
        const display = projectUserProfileDisplay(row);
        return {
          bindingId,
          authenticatedUserProfile: {
            profileId,
            displayName: display.displayName,
            avatarRevision: display.avatarRevision,
            hasAvatar: display.hasAvatar,
            updatedAt: row.updated_at,
          },
          preparedSessionProfile: {
            profileId,
            role: profile.assignedRole,
            githubLogin: profile.githubLogin ?? null,
            aliases,
          },
          operatorRoleActor:
            principal.kind === "owner" ? { kind: "system" } : { kind: "operator", profileId },
          operatorRolePolicy: role,
          operatorAccessAuthority: access,
          scopes: role ? intersectOperatorScopes(ceiling, role.scopes) : [...ceiling],
          assertCurrent,
          signal,
        };
      },
      close() {
        invalidated.abort(
          new GatewayControlUiIngressError("closed", "Remote ingress principal binding is closed."),
        );
      },
    };
  } catch (error) {
    return invalidate(error);
  }
}
