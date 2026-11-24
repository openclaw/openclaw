// An OpenClaw ID member's browser asks for, and is paired with, exactly its current profile role.
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
import { formatForLog } from "../../ws-log.js";
import { applyConnectionScopeCap, rejectUnavailableProfileConnect } from "./connect-admission.js";
import { rejectGatewayConnectOperatorAccess } from "./connect-operator-access.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

/**
 * Prepares an OpenClaw ID member's Control UI connect before pairing. The browser may still send
 * the scopes it saved under an earlier role, so the connect asks for exactly the member's current
 * profile role (the ceiling connect-session also applies), and an already-approved device on this
 * key has its stored operator grant set to that role first. Promotion then needs no device
 * approval, demotion narrows the grant, and the grant never exceeds the role.
 * Returns `null` for other connects. Returns `undefined` after refusing the connect: a role that
 * grants nothing (before any pairing write), an unavailable profile, or a role that changed while
 * the grant was being stored (the client reconnects under the current role).
 */
export async function prepareOpenClawIdMemberConnect(
  context: GatewayConnectPhaseContext,
  state: AuthenticatedGatewayConnect,
  isConnectAuthorizationCurrent: () => boolean,
): Promise<string[] | null | undefined> {
  const { role, authMethod, authResult, device, devicePublicKey } = state;
  const principal = authResult.openclawId;
  if (
    role !== "operator" ||
    authMethod !== "trusted-proxy" ||
    principal?.kind !== "member" ||
    !(state.isBrowserOperatorUi || state.isWebchat)
  ) {
    return null;
  }
  try {
    const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({
      accountId: principal.accountId,
    });
    const authority = await prepareUserProfileRoleAuthority(profile.id);
    const roleScopes =
      openclawIdSubjectRolePolicy(principal, () =>
        resolveOperatorRolePolicyForAssignment(
          profile.id,
          authority?.role ?? null,
          context.configSnapshot,
          authority?.githubLogin ?? null,
          operatorRoleSubject(authority ?? undefined),
        ),
      )?.scopes ?? [];
    if (roleScopes.length === 0) {
      await rejectGatewayConnectOperatorAccess(
        context,
        new GatewayOperatorAccessDeniedError("access-record-inactive"),
      );
      return undefined;
    }
    // A connection scope header caps this connect only; it never narrows the stored grant.
    const scopes = applyConnectionScopeCap({
      role,
      scopes: [...roleScopes],
      upgradeReq: context.handler.upgradeReq,
    });
    const paired = device && devicePublicKey ? await getPairedDevice(device.id) : null;
    const change =
      device && devicePublicKey
        ? resolveMemberOperatorGrantChange(paired, devicePublicKey, roleScopes)
        : null;
    if (change && device && devicePublicKey) {
      await executeDevicePairingMutation(
        {
          type: "devicePairing.setOpenClawIdMemberGrant",
          input: {
            deviceId: device.id,
            publicKey: devicePublicKey,
            scopes: [...roleScopes],
            nowMs: Date.now(),
          },
        },
        {
          assertCurrent: () => {
            if (!isConnectAuthorizationCurrent() || authority?.isCurrent() === false) {
              throw new DevicePairingAuthorityRefusedError("OpenClaw ID member role changed");
            }
          },
        },
      );
      context.handler.logGateway.warn(
        `security audit: OpenClaw ID member device grant set to its role device=${formatForLog(device.id.slice(0, 12))} scopesFrom=${formatForLog((paired?.approvedScopes ?? paired?.scopes ?? []).join(",") || "<none>")} scopesTo=${formatForLog(change.tokenScopes.join(","))}`,
      );
    }
    return scopes;
  } catch (error) {
    await rejectUnavailableProfileConnect(context, error);
    return undefined;
  }
}
