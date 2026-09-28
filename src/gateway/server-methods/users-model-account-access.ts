import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import {
  prepareUserProfileRoleAuthority,
  prepareUserProfileSelectionAuthority,
} from "../../state/user-channel-identity-operations.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { isUserModelAuthProfileOwner } from "../../state/user-model-accounts.js";
import { ensureProfileIdForEmail } from "../../state/user-profile-email.js";
import { UserProfileNotFoundError } from "../../state/user-profiles-schema.js";
import type {
  ModelAccountConnectAction,
  UserModelAccountSelection,
} from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { resolveOperatorRolePolicyForProfile } from "../operator-role-policy.js";
import { SESSION_READ_SCOPE, SESSION_WRITE_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import { isIneligiblePersonalGatewayCaller } from "./gateway-personal-caller.js";
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
): Promise<ModelAccountConnectAction> {
  const { client, context } = options;
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const userReference = client?.authenticatedUserId;
  const connectionId = client?.connId;
  const assertConnectionCurrent = () => {
    // A copied identity, retained scopes, or a replacement socket cannot keep
    // the original action alive after disconnect or role invalidation.
    if (
      !client?.connId ||
      client.connId !== connectionId ||
      client.invalidated ||
      client.connectionSignal?.aborted ||
      client.connect.role !== "operator" ||
      isIneligiblePersonalGatewayCaller(client) ||
      options.signal?.aborted ||
      isGatewayClientProfilePending(client) ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId) ||
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
        ? prepareUserProfileSelectionAuthority(actorReference)
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
  const assertCurrent = () => {
    assertConnectionCurrent();
    if (!actorIdentity.isCurrent() || !ownerIdentity.isCurrent()) {
      throw new ModelAccountConnectAuthorityError();
    }
    const scope = actor === owner ? requiredScope : "operator.admin";
    const role = resolveOperatorRolePolicyForProfile(actor, context.getRuntimeConfig());
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
  return { owner, assertCurrent };
}

/** Preview and commit share the same self-owned selection; scope follows the requested action. */
export async function preparePersonalModelAccountSelection(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">,
  authProfileId: string,
  requiredScope: PersonalModelSelectionScope = "operator.write",
): Promise<UserModelAccountSelection> {
  const action = await prepareUserModelAccountAction(options, undefined, requiredScope);
  const assertCurrent = () => {
    action.assertCurrent();
    if (!isUserModelAuthProfileOwner({ profileId: action.owner, authProfileId })) {
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
  const personalAccountDefaults =
    client?.connId && client.authenticatedUserProfile && !isIneligiblePersonalGatewayCaller(client)
      ? await prepareUserModelAccountAction(
          options,
          undefined,
          readGatewayRequestMutationAuthority(options).sessionScope === SESSION_WRITE_SCOPE
            ? SESSION_WRITE_SCOPE
            : WRITE_SCOPE,
        )
      : undefined;
  return { personalAccountDefaults };
}
