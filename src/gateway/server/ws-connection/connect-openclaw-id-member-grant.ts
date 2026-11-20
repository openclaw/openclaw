// An OpenClaw ID member's browser is paired with exactly its current profile role.
import { resolveMemberOperatorGrantChange } from "../../../infra/device-pairing-identity.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "../../../infra/device-pairing-worker.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import { prepareUserProfileRoleAuthority } from "../../../state/user-channel-identity-operations.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../../../state/user-profile-writes.js";
import { openclawIdSubjectRolePolicy } from "../../openclaw-id/tunnel-principal.js";
import { GatewayOperatorAccessDeniedError } from "../../operator-access-policy.js";
import { operatorRoleSubject } from "../../operator-role-enforcement.js";
import { resolveOperatorRolePolicyForAssignment } from "../../operator-role-policy.js";
import { applyConnectionScopeCap, rejectUnavailableProfileConnect } from "./connect-admission.js";
import { rejectGatewayConnectOperatorAccess } from "./connect-operator-access.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

/**
 * The scopes an OpenClaw ID member's Control UI connect asks for: exactly its current profile
 * role, so a browser that saved an earlier role's scopes cannot pin itself there. connect-session
 * applies the same role as the ceiling. Returns `null` for other connects and `undefined` after
 * refusing a member whose role grants nothing (before any pairing write) or whose profile is
 * unavailable.
 */
export async function resolveOpenClawIdMemberConnectScopes(
  context: GatewayConnectPhaseContext,
  state: AuthenticatedGatewayConnect,
): Promise<string[] | null | undefined> {
  const { role, authMethod, authResult } = state;
  const principal = authResult.openclawId;
  if (
    role !== "operator" ||
    authMethod !== "trusted-proxy" ||
    principal?.kind !== "member" ||
    !(state.isBrowserOperatorUi || state.isWebchat)
  ) {
    return null;
  }
  let roleScopes: readonly string[];
  try {
    const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({
      accountId: principal.accountId,
    });
    const authority = await prepareUserProfileRoleAuthority(profile.id);
    roleScopes =
      openclawIdSubjectRolePolicy(principal, () =>
        resolveOperatorRolePolicyForAssignment(
          profile.id,
          authority?.role ?? null,
          context.configSnapshot,
          authority?.githubLogin ?? null,
          operatorRoleSubject(authority ?? undefined),
        ),
      )?.scopes ?? [];
  } catch (error) {
    await rejectUnavailableProfileConnect(context, error);
    return undefined;
  }
  const scopes = applyConnectionScopeCap({
    role,
    scopes: [...roleScopes],
    upgradeReq: context.handler.upgradeReq,
  });
  if (scopes.length === 0) {
    await rejectGatewayConnectOperatorAccess(
      context,
      new GatewayOperatorAccessDeniedError("access-record-inactive"),
    );
    return undefined;
  }
  return scopes;
}

/**
 * Stores exactly the role's scopes as the member device's operator grant once its pairing is
 * authorized: approval merges grants, and a demotion needs no pairing at all.
 */
export async function storeOpenClawIdMemberGrant(params: {
  deviceId: string;
  publicKey: string;
  scopes: string[];
  isCurrent: () => boolean;
}): Promise<void> {
  const { deviceId, publicKey, scopes } = params;
  if (!resolveMemberOperatorGrantChange(await getPairedDevice(deviceId), publicKey, scopes)) {
    return;
  }
  await executeDevicePairingMutation(
    {
      type: "devicePairing.setOpenClawIdMemberGrant",
      input: { deviceId, publicKey, scopes, nowMs: Date.now() },
    },
    {
      assertCurrent: () => {
        if (!params.isCurrent()) {
          throw new DevicePairingAuthorityRefusedError("OpenClaw ID member authority changed");
        }
      },
    },
  );
}
