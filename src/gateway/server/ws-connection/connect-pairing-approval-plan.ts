// Non-interactive pairing approval lanes: which lane (if any) may resolve a
// pairing request before it reaches an operator prompt.
import {
  normalizeSortedUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { ConnectPairingRequiredReason } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { getBoundDeviceBootstrapProfile } from "../../../infra/device-bootstrap.js";
import {
  listApprovedPairedDeviceRoles,
  type getPairedDevice,
} from "../../../infra/device-pairing.js";
import {
  resolveBootstrapProfileScopesForRole,
  resolveBootstrapProfileScopesForRoles,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { intersectOperatorScopes, roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { shouldAutoApproveNodePairingFromTrustedCidrs } from "../../node-pairing-auto-approve.js";
import {
  openclawIdTunnelRolePolicy,
  type OpenClawIdTunnelPrincipal,
} from "../../openclaw-id/tunnel-principal.js";
import {
  resolvePairedAccessScopes,
  isControlUiOwnerBootstrapProfile,
  isControlUiOperatorBootstrapProfile,
  isMobileNodeBootstrapConnect,
  isSetupCodeHandoffBootstrapClient,
} from "./connect-device-metadata.js";
import { shouldAllowSilentLocalPairing } from "./handshake-auth-helpers.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

const DEFAULT_TRUSTED_PROXY_DEVICE_AUTO_APPROVE_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
] as const;

function resolveTrustedProxyDeviceAutoApproveScopes(params: {
  requestedScopes: string[];
  hasRequestedScopes: boolean;
  configuredScopes?: readonly string[];
}): string[] {
  const configuredScopes = normalizeSortedUniqueTrimmedStringList(
    params.configuredScopes ?? [...DEFAULT_TRUSTED_PROXY_DEVICE_AUTO_APPROVE_SCOPES],
  );
  if (!params.hasRequestedScopes) {
    return configuredScopes;
  }
  const configured = new Set(configuredScopes);
  // Trusted-proxy Control UI tabs can remain open across upgrades. Grant newly
  // required default UI scopes without widening an explicitly configured cap.
  return normalizeSortedUniqueTrimmedStringList([
    ...params.requestedScopes,
    ...(params.configuredScopes === undefined ? ["operator.questions"] : []),
  ]).filter((scope) => configured.has(scope));
}

// Owner devices pair with what they request; members with their role's ceiling.
function resolveOpenClawIdPairingScopes(
  requestedScopes: string[],
  principal: OpenClawIdTunnelPrincipal | undefined,
): string[] {
  const policy = openclawIdTunnelRolePolicy(principal);
  return policy ? intersectOperatorScopes(requestedScopes, policy.scopes) : requestedScopes;
}

/** One approval lane per pairing request; exactly one wins, "manual" prompts. */
export type PairingApprovalPlan = {
  /** Request is created silent and immediately self-approved by its lane. */
  silent: boolean;
  localApproval: "silent" | "trusted-cidr" | null;
  autoApproveOperatorScopes: string[] | null;
  operatorApprovalKind: "trusted-proxy" | "remote-ingress" | null;
  trustedProxyUser: string | undefined;
  isSameKeyScopeUpgrade: boolean;
  /** OpenClaw ID re-issue of an approved role's revoked token, within its approved scopes. */
  restoresApprovedAccess: boolean;
  allowSetupCodeHandoffBootstrapPairing: boolean;
  bootstrapApprovalProfile: DeviceBootstrapProfile | null;
  bootstrapPairingRoles: string[] | undefined;
  bootstrapPairingScopes: string[] | undefined;
};

type PairingApprovalPlanParams = {
  reason: ConnectPairingRequiredReason;
  existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null;
  state: AuthenticatedGatewayConnect;
  connectParams: GatewayConnectPhaseContext["connectParams"];
  configSnapshot: GatewayConnectPhaseContext["configSnapshot"];
  hasBrowserOriginHeader: boolean;
  reportedClientIp: string | undefined;
  reportedClientIpSource: GatewayConnectPhaseContext["reportedClientIpSource"];
  deviceId: string;
  devicePublicKey: string;
  scopes: string[];
  hasRequestedScopes: boolean;
  connectionScopeCap: (scopes: string[]) => string[];
};

/** Reused at planning and synchronous approval commit so config changes revoke the same policy. */
export function resolveLocalPairingApproval(
  params: Pick<
    PairingApprovalPlanParams,
    | "reason"
    | "existingPairedDevice"
    | "state"
    | "configSnapshot"
    | "scopes"
    | "hasBrowserOriginHeader"
    | "reportedClientIpSource"
    | "reportedClientIp"
  >,
): PairingApprovalPlan["localApproval"] {
  const { reason, existingPairedDevice, state, configSnapshot, scopes } = params;
  const { role, isControlUi, isWebchat, isNativeAppUi, authMethod, pairingLocality } = state;
  // Adding a first node role is not a token replacement. Keep real node-token
  // repairs, scope upgrades, and browser requests on their existing approval path.
  const addingLocalNodeRole =
    role === "node" &&
    reason === "role-upgrade" &&
    existingPairedDevice?.publicKey === state.devicePublicKey &&
    !existingPairedDevice?.tokens?.node &&
    scopes.length === 0 &&
    !params.hasBrowserOriginHeader &&
    !isControlUi &&
    !isWebchat;
  const allowSilentLocalPairing =
    (!existingPairedDevice || role === "operator" || addingLocalNodeRole) &&
    shouldAllowSilentLocalPairing({
      autoApproveLocal: configSnapshot.gateway?.nodes?.pairing?.autoApproveLocal,
      locality: pairingLocality,
      hasBrowserOriginHeader: params.hasBrowserOriginHeader,
      isControlUi,
      isWebchat,
      isNativeAppUi,
      authMethod,
      reason,
    });
  if (allowSilentLocalPairing) {
    return "silent";
  }
  return shouldAutoApproveNodePairingFromTrustedCidrs({
    existingPairedDevice: Boolean(existingPairedDevice),
    role,
    reason,
    scopes,
    hasBrowserOriginHeader: params.hasBrowserOriginHeader,
    isControlUi,
    isWebchat,
    reportedClientIpSource: params.reportedClientIpSource,
    reportedClientIp: params.reportedClientIp,
    autoApproveCidrs: configSnapshot.gateway?.nodes?.pairing?.autoApproveCidrs,
  })
    ? "trusted-cidr"
    : null;
}

export async function resolvePairingApprovalPlan(
  params: PairingApprovalPlanParams,
): Promise<PairingApprovalPlan> {
  const { reason, existingPairedDevice, state, connectParams, configSnapshot, scopes } = params;
  const {
    role,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
    authMethod,
    authResult,
    bootstrapTokenCandidate,
  } = state;
  const localApproval = resolveLocalPairingApproval(params);
  const trustedProxyAutoApproveConfig =
    configSnapshot.gateway?.auth?.trustedProxy?.deviceAutoApprove;
  const trustedProxyUser = authResult.user?.trim();
  // A scope upgrade from a device whose paired public key matches the one
  // this connect just proved by signature is the same physical device
  // behind the trusted ingress — auto-approvable like a first pairing. A key
  // mismatch stays a manual owner decision (possible deviceId squat).
  const isSameKeyScopeUpgrade =
    reason === "scope-upgrade" && existingPairedDevice?.publicKey === params.devicePublicKey;
  // An admitted OpenClaw ID tunnel device was approved by the claw's owner when it
  // joined, so its browser and app clients pair within its membership ceiling.
  const openclawIdPrincipal = authMethod === "trusted-proxy" ? authResult.openclawId : undefined;
  const openclawIdPairing =
    openclawIdPrincipal !== undefined && (isBrowserOperatorUi || isWebchat || isNativeAppUi);
  const operatorApprovalKind =
    authMethod === "remote-ingress" && state.remoteIngressPrincipal
      ? "remote-ingress"
      : openclawIdPairing
        ? "trusted-proxy"
        : authMethod === "trusted-proxy" &&
            (isBrowserOperatorUi || isWebchat || isNativeAppUi) &&
            Boolean(trustedProxyUser) &&
            trustedProxyAutoApproveConfig?.enabled === true
          ? "trusted-proxy"
          : null;
  // OpenClaw ID sign-out revokes the browser's tokens but keeps its device approved
  // (OCF-495), so its next connect asks for an approved role without an active token.
  // Only the OpenClaw ID lane re-issues it: that lane would pair a fresh key for this
  // principal anyway. Scopes beyond the approved row stay an owner decision below.
  const isSameKeyApprovedRoleReissue =
    openclawIdPairing &&
    reason === "role-upgrade" &&
    existingPairedDevice?.publicKey === params.devicePublicKey &&
    listApprovedPairedDeviceRoles(existingPairedDevice).includes(role);
  const laneOperatorScopes =
    ((reason === "not-paired" && !existingPairedDevice) ||
      isSameKeyScopeUpgrade ||
      isSameKeyApprovedRoleReissue) &&
    role === "operator" &&
    operatorApprovalKind !== null
      ? params.connectionScopeCap(
          operatorApprovalKind === "remote-ingress"
            ? scopes
            : openclawIdPairing
              ? resolveOpenClawIdPairingScopes(scopes, openclawIdPrincipal)
              : resolveTrustedProxyDeviceAutoApproveScopes({
                  requestedScopes: scopes,
                  hasRequestedScopes: params.hasRequestedScopes,
                  configuredScopes: trustedProxyAutoApproveConfig?.scopes,
                }),
        )
      : null;
  const restoresApprovedAccess =
    isSameKeyApprovedRoleReissue &&
    laneOperatorScopes !== null &&
    roleScopesAllow({
      role,
      requestedScopes: laneOperatorScopes,
      allowedScopes: resolvePairedAccessScopes(existingPairedDevice),
    });
  const autoApproveOperatorScopes =
    isSameKeyApprovedRoleReissue && !restoresApprovedAccess ? null : laneOperatorScopes;
  const isSetupCodeMobileNodeConnect = isMobileNodeBootstrapConnect({
    role,
    scopes,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    clientMode: connectParams.client.mode,
  });
  const allowBoundBootstrapProfileLookup =
    ((reason === "not-paired" && !existingPairedDevice) ||
      (reason === "scope-upgrade" && Boolean(existingPairedDevice))) &&
    (isSetupCodeMobileNodeConnect || (isControlUi && role === "operator"));
  const boundBootstrapProfile =
    authMethod === "bootstrap-token" && bootstrapTokenCandidate && allowBoundBootstrapProfileLookup
      ? await getBoundDeviceBootstrapProfile({
          token: bootstrapTokenCandidate,
          deviceId: params.deviceId,
          publicKey: params.devicePublicKey,
        })
      : null;
  const allowSetupCodeHandoffBootstrapPairing =
    boundBootstrapProfile !== null &&
    isSetupCodeMobileNodeConnect &&
    isSetupCodeHandoffBootstrapClient({
      profile: boundBootstrapProfile,
      client: connectParams.client,
    });
  const setupCodeHandoffBootstrapProfile = allowSetupCodeHandoffBootstrapPairing
    ? boundBootstrapProfile
    : null;
  const allowControlUiOwnerBootstrapPairing =
    reason === "scope-upgrade" &&
    isControlUiOwnerBootstrapProfile({
      profile: boundBootstrapProfile,
      requestedScopes: scopes,
    });
  const allowControlUiOperatorBootstrapPairing =
    (reason === "not-paired" &&
      isControlUiOperatorBootstrapProfile({
        profile: boundBootstrapProfile,
        requestedScopes: scopes,
      })) ||
    allowControlUiOwnerBootstrapPairing;
  const controlUiOperatorBootstrapProfile = allowControlUiOperatorBootstrapPairing
    ? boundBootstrapProfile
    : null;
  // This is the native QR/setup-code onboarding seam. Mobile clients
  // must prove their canonical client id and platform/family metadata
  // agree before the Gateway can skip owner approval and hand off the
  // selected operator profile below. Full mobile setup includes admin;
  // limited setup retains the previous bounded operator scope set.
  const bootstrapPairingRoles = setupCodeHandoffBootstrapProfile
    ? uniqueStrings([role, ...setupCodeHandoffBootstrapProfile.roles])
    : controlUiOperatorBootstrapProfile
      ? ["operator"]
      : undefined;
  const bootstrapPairingScopes = setupCodeHandoffBootstrapProfile
    ? resolveBootstrapProfileScopesForRoles(
        bootstrapPairingRoles ?? [],
        setupCodeHandoffBootstrapProfile.scopes,
        setupCodeHandoffBootstrapProfile.purpose,
      )
    : controlUiOperatorBootstrapProfile
      ? resolveBootstrapProfileScopesForRole(
          "operator",
          controlUiOperatorBootstrapProfile.scopes,
          controlUiOperatorBootstrapProfile.purpose,
        )
      : undefined;
  return {
    // Scope upgrades ride the same silent-local rule as initial pairing:
    // shouldAllowSilentLocalPairing already restricts them to local-grade
    // auth (none/token/password), so identity-proxy and bearer-token rows
    // stay a durable cap while owner-credentialed local clients widen
    // without a prompt they could bypass with a fresh identity anyway.
    silent:
      localApproval !== null ||
      allowSetupCodeHandoffBootstrapPairing ||
      allowControlUiOperatorBootstrapPairing,
    localApproval,
    autoApproveOperatorScopes,
    operatorApprovalKind,
    trustedProxyUser,
    isSameKeyScopeUpgrade,
    restoresApprovedAccess,
    allowSetupCodeHandoffBootstrapPairing,
    bootstrapApprovalProfile: setupCodeHandoffBootstrapProfile ?? controlUiOperatorBootstrapProfile,
    bootstrapPairingRoles,
    bootstrapPairingScopes,
  };
}
