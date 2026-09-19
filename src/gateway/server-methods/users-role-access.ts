import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { UserProfileRoleMutationGuard } from "../../state/user-profiles-role.types.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "../operator-role-policy.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "../role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const METHOD = "users.setRole";

function assertRoleMutationScopes(scopes: readonly string[]): void {
  const authorized = authorizeOperatorScopesForMethod(METHOD, scopes);
  if (!authorized.allowed) {
    throw new SessionMutationAuthorizationChangedError(
      missingScopeErrorShape({
        missingScope: authorized.missingScope,
        requiredScopes: [authorized.missingScope],
      }),
    );
  }
}

/** Retain request authority while the transaction supplies current profile facts. */
export function prepareUserProfileRoleMutation(
  options: GatewayRequestHandlerOptions,
  role: string | null,
): UserProfileRoleMutationGuard {
  const { client, context } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const requesterReference = client?.authenticatedUserProfile?.profileId ?? null;
  const actor = resolveGatewayOperatorRoleActor(client);
  const actorKind = actor?.kind;
  const actorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const assertPolicyCurrent = () => {
    if (client?.connect) {
      const roleRaw = client.connect.role ?? "operator";
      const gatewayRole = parseGatewayRole(roleRaw);
      if (!gatewayRole || !isRoleAuthorizedForMethod(gatewayRole, METHOD)) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, `unauthorized role: ${roleRaw}`),
        );
      }
      assertRoleMutationScopes(client.connect.scopes ?? []);
    }
    const currentActor = resolveGatewayOperatorRoleActor(client);
    if (
      (client?.authenticatedUserProfile?.profileId ?? null) !== requesterReference ||
      currentActor?.kind !== actorKind ||
      (currentActor?.kind === "operator" ? currentActor.profileId : undefined) !== actorProfileId
    ) {
      throw new Error("Profile role requester authority changed");
    }
    const cfg = context.getRuntimeConfig();
    const definitions = cfg.gateway?.roles?.definitions;
    if (role !== null && (!definitions || !Object.hasOwn(definitions, role))) {
      throw new SessionMutationAuthorizationChangedError(
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unknown operator role "${role}"; define it under gateway.roles.definitions before assigning it`,
        ),
      );
    }
    return cfg;
  };
  if (
    authority.family === "native-compatibility" ||
    (actorKind === "operator" && actorProfileId !== requesterReference)
  ) {
    // A distinct in-process actor and opaque guards need their native identity reads.
    const assertCurrent = () => {
      authority.assertCurrent();
      assertPolicyCurrent();
    };
    assertCurrent();
    return { family: "native-compatibility", assertCurrent };
  }
  const assertCurrent = () => {
    authority.assertWorkerCurrent();
    assertPolicyCurrent();
  };
  assertCurrent();
  return {
    family: "worker",
    requesterReference,
    assertCurrent,
    assertRequester(facts) {
      authority.assertWorkerCurrent();
      const cfg = assertPolicyCurrent();
      if ((requesterReference === null) !== (facts.profileId === null)) {
        throw new Error("Profile role requester authority changed");
      }
      authority.expectedProfileBinding?.assertMatchesResolvedProfile(facts.profileId ?? undefined);
      const policy =
        actorKind === "system"
          ? undefined
          : resolveOperatorRolePolicyForAssignment(
              facts.profileId ?? undefined,
              facts.assignedRole,
              cfg,
            );
      if (policy) {
        assertRoleMutationScopes(policy.scopes);
      }
    },
  };
}
