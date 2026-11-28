import { GATEWAY_CLIENT_IDS } from "../../../../packages/gateway-protocol/src/client-info.js";
import { ensureDeviceToken } from "../../../infra/device-pairing-tokens.js";
import { getPairedDevice } from "../../../infra/device-pairing.js";
import { resolveBootstrapProfileScopesForRole } from "../../../shared/device-bootstrap-profile.js";
import {
  openclawIdPeerKeyOf,
  recordDeviceTokenPeer,
  recordTokenlessOpenClawIdOperator,
} from "../../openclaw-id/device-token-binding.js";
import {
  isOperatorRoleEnforcedFor,
  operatorRoleSubject,
  type OperatorRoleSubject,
} from "../../operator-role-enforcement.js";
import type {
  GatewayConnectPhaseContext,
  AuthenticatedGatewayConnect,
  DeviceAuthorizedGatewayConnect,
} from "./message-handler-types.js";

type DeviceTokenInputs = Pick<
  AuthenticatedGatewayConnect,
  | "role"
  | "device"
  | "isBrowserOperatorUi"
  | "isControlUi"
  | "isWebchat"
  | "trustedProxyAuthOk"
  | "sessionUsesSharedGatewayAuth"
  | "sessionSharedGatewaySessionGeneration"
  | "deviceTokenSharedGatewaySessionGeneration"
  | "handoffBootstrapProfile"
  | "authResult"
  | "remoteIngressPrincipal"
  | "scopes"
>;
type DeviceTokenContext = Pick<
  GatewayConnectPhaseContext,
  "configSnapshot" | "hasBrowserOriginHeader" | "recordAttachTiming"
> & {
  handler: { ingressAttribution: Parameters<typeof openclawIdPeerKeyOf>[0] };
};

async function issueGatewayConnectDeviceTokens(params: {
  state: DeviceTokenInputs;
  scopes: string[];
  hasApprovedDeviceBaseline: boolean;
  /** Opt-in: a non-browser operator UI (the TUI) behind the trusted proxy keeps a device token. */
  issueToTrustedProxyCliUi: boolean;
  isIssuanceCurrent: () => boolean;
}): Promise<Pick<DeviceAuthorizedGatewayConnect, "deviceToken" | "bootstrapDeviceTokens">> {
  const { state, scopes, hasApprovedDeviceBaseline } = params;
  const {
    role,
    device,
    isBrowserOperatorUi,
    isWebchat,
    trustedProxyAuthOk,
    sessionUsesSharedGatewayAuth,
    sessionSharedGatewaySessionGeneration,
    deviceTokenSharedGatewaySessionGeneration,
    handoffBootstrapProfile,
  } = state;
  const sharedGatewayAuthIssuer =
    sessionSharedGatewaySessionGeneration &&
    (deviceTokenSharedGatewaySessionGeneration !== undefined ||
      (sessionUsesSharedGatewayAuth && (isBrowserOperatorUi || isWebchat)))
      ? {
          kind: "shared-gateway-auth" as const,
          generation: sessionSharedGatewaySessionGeneration,
        }
      : undefined;
  const nodePrincipal = role === "node" ? state.authResult.openclawId : undefined;
  // Manual re-pairing stays manual, but its issued role still belongs to this live listing.
  const trustedProxyCliUi = params.issueToTrustedProxyCliUi && !isBrowserOperatorUi && !isWebchat;
  const issuedDeviceGrant =
    (!trustedProxyAuthOk || trustedProxyCliUi) && device && hasApprovedDeviceBaseline
      ? await ensureDeviceToken({
          deviceId: device.id,
          role,
          scopes,
          issuer: sharedGatewayAuthIssuer,
          approval:
            nodePrincipal?.kind === "node" && nodePrincipal.authority
              ? {
                  approvedVia: "openclaw-id-node",
                  peerKey: nodePrincipal.peerKey,
                  authority: nodePrincipal.authority,
                }
              : undefined,
          isIssuanceCurrent: params.isIssuanceCurrent,
        })
      : null;
  const bootstrapDeviceTokens: DeviceAuthorizedGatewayConnect["bootstrapDeviceTokens"] = [];
  if (issuedDeviceGrant) {
    bootstrapDeviceTokens.push({
      deviceToken: issuedDeviceGrant.token,
      role: issuedDeviceGrant.role,
      scopes: issuedDeviceGrant.scopes,
      issuedAtMs: issuedDeviceGrant.rotatedAtMs ?? issuedDeviceGrant.createdAtMs,
    });
  }
  if (device && handoffBootstrapProfile) {
    for (const bootstrapRole of handoffBootstrapProfile.roles) {
      if (bootstrapDeviceTokens.some((entry) => entry.role === bootstrapRole)) {
        continue;
      }
      // Extra hello-ok handoff tokens are only emitted for the approved
      // setup-code profile. Operator scopes are filtered through the closed
      // mobile allowlist selected when the setup code was issued.
      const bootstrapRoleScopes =
        bootstrapRole === "operator"
          ? resolveBootstrapProfileScopesForRole(
              bootstrapRole,
              handoffBootstrapProfile.scopes,
              handoffBootstrapProfile.purpose,
            )
          : [];
      const extraToken = await ensureDeviceToken({
        deviceId: device.id,
        role: bootstrapRole,
        scopes: bootstrapRoleScopes,
        isIssuanceCurrent: params.isIssuanceCurrent,
      });
      if (!extraToken) {
        continue;
      }
      bootstrapDeviceTokens.push({
        deviceToken: extraToken.token,
        role: extraToken.role,
        scopes: extraToken.scopes,
        issuedAtMs: extraToken.rotatedAtMs ?? extraToken.createdAtMs,
      });
    }
  }
  return { deviceToken: issuedDeviceGrant, bootstrapDeviceTokens };
}

/** Complete person-bound token policy only after canonical profile preparation. */
export function createGatewayConnectDeviceTokenPreparation(
  context: DeviceTokenContext,
  state: DeviceTokenInputs,
  hasServerApprovedDeviceTokenBaseline: boolean,
) {
  const { role, authResult, scopes, handoffBootstrapProfile } = state;
  const { configSnapshot } = context;
  // Ingress authenticates exclusively from its live principal grant and signed
  // device proof. Never mint a reusable credential that can outlive that grant.
  return async (subject: OperatorRoleSubject, isSubjectCurrent: () => boolean = () => true) => {
    const tokensStartedAt = performance.now();
    const { deviceToken, bootstrapDeviceTokens } =
      state.remoteIngressPrincipal ||
      (role === "operator" &&
        authResult.openclawId?.kind !== "owner" &&
        (isOperatorRoleEnforcedFor(configSnapshot, subject) || subject.openclawIdMember) &&
        authResult.user?.trim())
        ? { deviceToken: null, bootstrapDeviceTokens: [] }
        : await issueGatewayConnectDeviceTokens({
            state: { ...state, scopes, handoffBootstrapProfile },
            scopes,
            hasApprovedDeviceBaseline: hasServerApprovedDeviceTokenBaseline,
            issueToTrustedProxyCliUi:
              configSnapshot.gateway?.auth?.trustedProxy?.narrowToDeviceGrant === true &&
              !context.hasBrowserOriginHeader,
            isIssuanceCurrent: isSubjectCurrent,
          });

    // A token issued over the OpenClaw ID tunnel belongs to the device key that obtained it.
    const issuedPeerKey = openclawIdPeerKeyOf(context.handler.ingressAttribution);
    if (issuedPeerKey && state.device) {
      for (const issued of [deviceToken, ...bootstrapDeviceTokens]) {
        if (issued) {
          await recordDeviceTokenPeer({
            deviceId: state.device.id,
            role: issued.role,
            peerKey: issuedPeerKey,
          });
        }
      }
      if (role === "operator" && !deviceToken && state.isControlUi) {
        // Lanes that issue no token still mark the browser as managed on the Access page.
        // Approval may have persisted a token this lane never delivers; binding it keeps that
        // token on the membership lifecycle. Browser device keys are per origin, so a token
        // issued to this key on ordinary ingress needs the same origin there too (accepted).
        const current = await getPairedDevice(state.device.id);
        if (current?.clientId === GATEWAY_CLIENT_IDS.CONTROL_UI) {
          await recordTokenlessOpenClawIdOperator(state.device.id, issuedPeerKey);
        }
      }
    }
    context.recordAttachTiming?.("deviceTokensMs", tokensStartedAt);

    return { deviceToken, bootstrapDeviceTokens };
  };
}

export async function completeGatewayConnectDeviceTokens(
  state: Pick<
    DeviceAuthorizedGatewayConnect,
    | "authResult"
    | "prepareDeviceTokens"
    | "deviceToken"
    | "bootstrapDeviceTokens"
    | "isDeviceTokenSubjectCurrent"
  >,
  profile:
    | { profileId: string; openclawIdAccountIds?: readonly string[]; isCurrent: () => boolean }
    | undefined,
): Promise<void> {
  if (!state.prepareDeviceTokens) {
    return;
  }
  const prepare = state.prepareDeviceTokens;
  delete state.prepareDeviceTokens;
  const subject = operatorRoleSubject(profile);
  const isSubjectCurrent = () =>
    state.authResult.openclawId?.kind === "owner" || profile?.isCurrent() !== false;
  state.isDeviceTokenSubjectCurrent = isSubjectCurrent;
  const tokens = await prepare(subject, isSubjectCurrent);
  if (!isSubjectCurrent()) {
    throw new Error("Device token issuance ended. Reconnect to retry.");
  }
  Object.assign(state, tokens);
}
