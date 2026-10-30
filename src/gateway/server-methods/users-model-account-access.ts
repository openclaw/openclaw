import { assertAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import {
  prepareUserProfileRoleAuthority,
  prepareUserProfileRolePolicyAuthority,
  prepareUserProfileSelectionAuthority,
} from "../../state/user-channel-identity-operations.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { prepareUserModelAccountAuthority } from "../../state/user-model-account-operations.js";
import { ensureProfileIdForEmail } from "../../state/user-profile-email.js";
import { UserProfileNotFoundError } from "../../state/user-profiles-schema.js";
import type {
  ModelAccountConnectAction,
  ModelAccountConnectWorkerAction,
  ModelAccountRole,
  UserModelAccountSelection,
} from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { resolveOperatorRolePolicyForAssignment } from "../operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import { hasCurrentPersonalGatewaySource } from "./gateway-personal-caller.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type PersonalModelSelectionScope = "operator.read" | "operator.write" | typeof SESSION_READ_SCOPE;

/** Capture human authority once; every later privileged use rechecks this exact connection. */
export async function prepareUserModelAccountAction(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">,
  profileId?: string,
  requiredScope:
    | PersonalModelSelectionScope
    | "operator.admin"
    | typeof SESSION_WRITE_SCOPE = WRITE_SCOPE,
): Promise<ModelAccountConnectWorkerAction> {
  const { client, context } = options;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userReference = client?.authenticatedUserId;
  const connectionId = client?.connId;
  const assertConnectionCurrent = () => {
    // A copied identity, retained scopes, or a replacement socket cannot keep
    // the original action alive after disconnect or role invalidation.
    if (
      !hasCurrentPersonalGatewaySource(client, context) ||
      client.connId !== connectionId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.connect.role !== "operator" ||
      options.signal?.aborted ||
      isGatewayClientProfilePending(client) ||
      client.authenticatedUserProfile?.profileId !== profileReference ||
      client.authenticatedUserId !== userReference
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  assertConnectionCurrent();
  const actorReference =
    profileReference ??
    (userReference &&
    !client?.authenticatedGitHubIdentitySync &&
    !client?.authenticatedUserIsTailscaleProvider
      ? await ensureProfileIdForEmail(userReference, {}, assertConnectionCurrent)
      : undefined);
  const actorIdentity = actorReference
    ? await (profileReference
        ? prepareUserProfileRolePolicyAuthority(actorReference)
        : prepareUserProfileRoleAuthority(actorReference))
    : undefined;
  assertConnectionCurrent();
  if (!actorIdentity) {
    throw new ModelAccountConnectAuthorityError();
  }
  const actor = actorIdentity.profileId;
  // Legacy email-only ingress must bind the alias after its authority capture,
  // otherwise a relink between the two reads could authorize the former owner.
  if (
    !profileReference &&
    userReference &&
    (await ensureProfileIdForEmail(userReference, {}, assertConnectionCurrent)) !== actor
  ) {
    throw new ModelAccountConnectAuthorityError();
  }
  const ownerReference = profileId ?? actor;
  const ownerIdentity =
    ownerReference === actor || ownerReference === actorReference
      ? actorIdentity
      : await prepareUserProfileSelectionAuthority(ownerReference);
  assertConnectionCurrent();
  if (!ownerIdentity) {
    throw new UserProfileNotFoundError(ownerReference);
  }
  const owner = ownerIdentity.profileId;
  const assertCurrent = (roles?: readonly ModelAccountRole[]) => {
    assertConnectionCurrent();
    if (!actorIdentity.isCurrent() || !ownerIdentity.isCurrent()) {
      throw new ModelAccountConnectAuthorityError();
    }
    const scope = actor === owner ? requiredScope : "operator.admin";
    const assignment = roles?.find((entry) => entry.profileId === actor);
    if (roles && !assignment) {
      throw new ModelAccountConnectAuthorityError();
    }
    const role = resolveOperatorRolePolicyForAssignment(
      actor,
      assignment ? assignment.role : actorIdentity.role,
      context.getRuntimeConfig(),
      actorIdentity.githubLogin ?? null,
    );
    const grants = [client?.connect.scopes ?? [], ...(role ? [role.scopes] : [])];
    if (
      !grants.every((allowedScopes) =>
        roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
      )
    ) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  assertCurrent();
  return { owner, actorProfileId: actor, assertCurrent };
}

/** Preview and commit share the same self-owned selection; scope follows the requested action. */
export async function preparePersonalModelAccountSelection(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">,
  authProfileId: string,
  requiredScope: PersonalModelSelectionScope = "operator.write",
): Promise<UserModelAccountSelection> {
  const action = await prepareUserModelAccountAction(options, undefined, requiredScope);
  const account = await prepareUserModelAccountAuthority({
    profileId: action.owner,
    authProfileId,
  });
  const assertCurrent = () => {
    action.assertCurrent();
    if (!account?.isCurrent()) {
      throw new ModelAccountConnectAuthorityError();
    }
  };
  assertCurrent();
  return { owner: action.owner, authProfileId, assertCurrent };
}

/** New personal selections require the human owner; inherited pins need no new selection. */
export function preparePersonalModelSelection(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">,
  model: string | null | undefined,
): Promise<UserModelAccountSelection> | undefined {
  const authProfileId =
    typeof model === "string" ? splitTrailingAuthProfile(model).profile : undefined;
  if (!authProfileId || !isUserModelAuthProfileId(authProfileId)) {
    return undefined;
  }
  return preparePersonalModelAccountSelection(options, authProfileId);
}

/** Default use follows this creation's admitted scope; explicit account selection stays write-scoped. */
export async function prepareSessionModelAccountAccess(
  options: GatewayRequestHandlerOptions,
  model: string | undefined,
): Promise<{
  personalModelSelection?: UserModelAccountSelection;
  personalAccountDefaults?: ModelAccountConnectAction;
}> {
  const personalModelSelection = preparePersonalModelSelection(options, model);
  if (personalModelSelection) {
    return { personalModelSelection: await personalModelSelection };
  }
  const { client } = options;
  const requestAuthority = readGatewayRequestMutationAuthority(options);
  const requiredScope =
    requestAuthority.sessionScope === SESSION_WRITE_SCOPE ? SESSION_WRITE_SCOPE : WRITE_SCOPE;
  const creation = client?.internal?.sessionCreation;
  if (creation?.via === "operator" && creation.requesterSessionKey) {
    // Ordinary tool creation may use the admitted person's saved default. This
    // does not make the synthetic caller a human account-selection connection.
    const operatorAuthority = client?.internal?.operatorRunAuthority;
    const caller = client?.internal?.agentToolCaller;
    if (!operatorAuthority) {
      throw new ModelAccountConnectAuthorityError();
    }
    const assertCurrent = composeSessionSourceAssertion(
      [requestAuthority.assertCurrent, operatorAuthority.assertCurrent, caller?.assertCurrent],
      (assertSources) => {
        try {
          assertAdmittedRunOperatorAuthority(operatorAuthority);
          assertSources();
          if (
            options.req.method !== "sessions.create" ||
            options.client !== client ||
            client?.connect.role !== "operator" ||
            client.internal?.operatorRunAuthority !== operatorAuthority ||
            client.internal.sessionCreation !== creation ||
            client.internal.agentToolCaller !== caller ||
            !caller?.assertCurrent ||
            caller.sessionKey !== creation.requesterSessionKey ||
            creation.actor?.type !== "human" ||
            creation.actor.source !== "profile" ||
            creation.actor.id !== operatorAuthority.profileId ||
            ![operatorAuthority.scopes, client.connect.scopes ?? []].every((allowedScopes) =>
              roleScopesAllow({
                role: "operator",
                requestedScopes: [requiredScope],
                allowedScopes,
              }),
            )
          ) {
            throw new ModelAccountConnectAuthorityError();
          }
        } catch {
          throw new ModelAccountConnectAuthorityError();
        }
      },
    );
    assertCurrent();
    return {
      personalAccountDefaults: { owner: operatorAuthority.profileId, assertCurrent },
    };
  }
  const personalAccountDefaults =
    hasCurrentPersonalGatewaySource(client, options.context) && client.authenticatedUserProfile
      ? await prepareUserModelAccountAction(options, undefined, requiredScope)
      : undefined;
  return { personalAccountDefaults };
}
