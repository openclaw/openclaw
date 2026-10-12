import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHostAccountName } from "../infra/host-account-name.js";
import {
  GatewayControlUiIngressError,
  type GatewayIngressPrincipal,
} from "../plugins/gateway-ingress.types.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import {
  captureResidentUserProfileAccess,
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
} from "../state/user-profile-list.js";
import { ensureCanonicalGatewayOwnerProfile } from "../state/user-profile-writes.js";
import type { UserProfileIdentity } from "../state/user-profiles.types.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { resolveGatewayOperatorAccessAuthority } from "./operator-access-policy.js";
import type { GatewayOperatorAccessAuthority } from "./operator-access-policy.types.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { remoteControlUiGatewayAuthError } from "./remote-control-ui-context.js";
import type { GatewayOperatorRoleActor } from "./server-methods/shared-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

export type RemoteIngressPrincipalSnapshot = Readonly<{
  bindingId: string;
  authenticatedUserProfile: NonNullable<GatewayWsClient["authenticatedUserProfile"]>;
  preparedSessionProfile: UserProfileIdentity;
  operatorRoleActor: GatewayOperatorRoleActor;
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
  operatorAccessAuthority?: GatewayOperatorAccessAuthority | null;
  scopes: string[];
  signal: AbortSignal;
  assertCurrent(): void;
}>;

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
  if (
    principal.kind === "person" &&
    (!principal.profileId.trim() || principal.profileId === GATEWAY_OWNER_PROFILE_ID)
  ) {
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
    assertGrant();
  }
  const prepared = await prepareUserProfileIdentity(profileId).catch(() => {
    throw new GatewayControlUiIngressError(
      "forbidden",
      "Remote ingress requires an available existing verified profile.",
    );
  });
  let releaseProfiles = () => {};
  let releaseRoles = () => {};
  let signal = AbortSignal.any([params.signal, invalidated.signal]);
  const release = () => {
    releaseProfiles();
    releaseRoles();
    signal.removeEventListener("abort", release);
    prepared.release();
  };
  const invalidate = (error: unknown): never => {
    const denial =
      error instanceof GatewayControlUiIngressError
        ? error
        : new GatewayControlUiIngressError(
            "forbidden",
            "Remote ingress principal authority changed; reopen the binding under current authority.",
          );
    invalidated.abort(denial);
    release();
    throw denial;
  };
  try {
    assertGrant();
    const resident = captureResidentUserProfileAccess(profileId);
    const initialIdentity = prepared.readCurrentFacts();
    const initial = initialIdentity.profile;
    const emailBindingIds = prepared.emailBindingIds;
    const readRole = () => {
      const current = prepared.readCurrentProfile(emailBindingIds, initial.githubAccountIds);
      return resolveOperatorRolePolicyForAssignment(
        profileId,
        current.assignedRole,
        params.getRuntimeConfig(),
        current.githubLogin ?? null,
      );
    };
    const role = principal.kind === "person" ? structuredClone(readRole()) : undefined;
    const access =
      principal.kind === "person"
        ? resolveGatewayOperatorAccessAuthority(profileId, params.getRuntimeConfig(), {
            requireLivePolicySet: true,
          })
        : undefined;
    signal = AbortSignal.any([
      params.signal,
      invalidated.signal,
      ...(access ? [access.signal] : []),
    ]);
    const assertCurrent = () => {
      try {
        signal.throwIfAborted();
        assertGrant();
        const currentIdentity = prepared.readCurrentFacts(emailBindingIds);
        const current = currentIdentity.profile;
        prepared.readCurrentProfile(emailBindingIds, initial.githubAccountIds);
        const allowedUsers = params.getResolvedAuth().trustedProxy?.allowUsers;
        if (
          current.profileId !== profileId ||
          resident.assertCurrent().merged_into !== null ||
          !isDeepStrictEqual(currentIdentity.aliases, initialIdentity.aliases) ||
          initial.emails.some((email) => !current.emails.includes(email)) ||
          (principal.kind === "person" &&
            allowedUsers?.length &&
            !current.emails.some((email) => allowedUsers.includes(email))) ||
          !isDeepStrictEqual(role, principal.kind === "person" ? readRole() : undefined)
        ) {
          throw new Error("Principal identity or role changed");
        }
        access?.assertCurrent();
      } catch (error) {
        invalidate(error);
      }
    };
    const checkPublication = () => {
      try {
        assertCurrent();
      } catch {
        /* The assertion already retired this grant. */
      }
    };
    releaseProfiles = onUserProfilesChanged(checkPublication);
    releaseRoles = onOperatorRolePolicyChanged(checkPublication);
    signal.addEventListener("abort", release, { once: true });
    assertCurrent();
    return {
      signal,
      resolve() {
        assertCurrent();
        const { profile, aliases } = prepared.readCurrentFacts(emailBindingIds);
        const row = resident.assertCurrent();
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
        release();
      },
    };
  } catch (error) {
    return invalidate(error);
  }
}
